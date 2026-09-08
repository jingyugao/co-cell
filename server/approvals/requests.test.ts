import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RequestUserApproval, UserApproval } from '../../shared/approval-types.js';
import type { Settings, Turn } from '../../shared/types.js';
import { SessionManager, type CodexClient } from '../sessions/manager.js';
import type { E2BRuntime } from '../sandboxes/e2b.js';
import { ApprovalRequests, cancelPersistedApprovals } from './requests.js';

const input = { title: '确认操作', target: 'uat / database', action: 'UPDATE example SET enabled = 0 WHERE id = 7;', impact: '修改一条记录' };
const makeTurn = (): Turn => ({ id: randomUUID(), prompt: '操作', images: [], items: [], status: 'running', startedAt: new Date().toISOString() });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('only a persisted explicit decision releases a waiter; duplicate decision is idempotent', async () => {
  for (const decision of ['approved', 'rejected'] as const) {
    const turn = makeTurn();
    let durable: Turn | undefined;
    const requests = new ApprovalRequests(turn, new AbortController().signal, async () => { durable = structuredClone(turn); });
    const id = randomUUID();
    const waiting = requests.request(id, input, new AbortController().signal);
    await tick();
    assert.equal(durable?.approvals?.[0].status, 'pending');
    await requests.decide(id, decision);
    assert.equal((await waiting).status, decision);
    assert.equal(durable?.approvals?.[0].status, decision);
    await requests.decide(id, decision);
    await assert.rejects(requests.decide(id, decision === 'approved' ? 'rejected' : 'approved'), /已处理/);
    await assert.rejects(requests.request(id, input, new AbortController().signal), /已使用/);
    await requests.close();
  }
});

test('abort during decision persistence never releases approval', async () => {
  const controller = new AbortController();
  const turn = makeTurn();
  let release!: () => void;
  let saving!: () => void;
  const savingApproval = new Promise<void>(resolve => { saving = resolve; });
  const requests = new ApprovalRequests(turn, controller.signal, async () => {
    if (turn.approvals?.[0].status === 'approved') {
      saving();
      await new Promise<void>(resolve => { release = resolve; });
    }
  });
  const id = randomUUID();
  const waiting = requests.request(id, input, controller.signal);
  await tick();
  const decision = requests.decide(id, 'approved');
  await savingApproval;
  controller.abort();
  release();
  await assert.rejects(decision, /失效/);
  assert.equal((await waiting).status, 'cancelled');
  await requests.close();
});

test('timeout, worker termination and invalid model-supplied approval all fail closed', async () => {
  for (const mode of ['timeout', 'close'] as const) {
    const turn = makeTurn();
    const controller = new AbortController();
    const requests = new ApprovalRequests(turn, controller.signal, async () => {}, 10);
    await assert.rejects(requests.request(randomUUID(), { ...input, decision: 'approved' }, controller.signal));
    await assert.rejects(requests.request(randomUUID(), { ...input, action: ' ' }, controller.signal));
    const id = randomUUID();
    const waiting = requests.request(id, input, controller.signal);
    await tick();
    if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 20));
    else await requests.close();
    assert.equal((await waiting).status, mode === 'timeout' ? 'expired' : 'cancelled');
    await assert.rejects(requests.decide(id, 'approved'), /已处理/);
    await requests.close();
  }
});

test('persistence failure cannot acknowledge approval', async () => {
  const turn = makeTurn();
  const requests = new ApprovalRequests(turn, new AbortController().signal, async () => {
    if (turn.approvals?.[0].status === 'approved') throw new Error('disk failed');
  });
  const id = randomUUID();
  const waiting = requests.request(id, input, new AbortController().signal);
  const rejected = assert.rejects(waiting, /disk failed/);
  await tick();
  await assert.rejects(requests.decide(id, 'approved'), /disk failed/);
  await rejected;
  assert.equal(turn.approvals?.[0].status, 'cancelled');
  await requests.close();
});

const defaults: Settings = { executionMode: 'e2b', workingDirectory: '/home/user/workspace', model: 'test', modelReasoningEffort: 'low',
  sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };

test('manager binds decisions to session and turn, cancels on stop and persists restart cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-approvals-'));
  let result: UserApproval | undefined;
  const runtime = { async close() {}, async *run(_session: unknown, _turn: unknown, signal: AbortSignal, _sandbox: unknown, approve: RequestUserApproval) {
    result = await approve(randomUUID(), input, signal);
    yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } };
  } } as unknown as E2BRuntime;
  const manager = new SessionManager({} as CodexClient, directory, defaults, runtime);
  try {
    await manager.init();
    const session = await manager.create();
    const other = await manager.create();
    const turnId = await manager.startTurn(session.id, '执行');
    for (let i = 0; i < 100 && !manager.get(session.id).turns[0].approvals?.length; i++) await tick();
    const approvalId = manager.get(session.id).turns[0].approvals![0].id;
    await assert.rejects(manager.resolveApproval(other.id, turnId, approvalId, { decision: 'approved' }), /不存在/);
    await assert.rejects(manager.resolveApproval(session.id, randomUUID(), approvalId, { decision: 'approved' }), /不存在/);
    await manager.stop(session.id);
    assert.equal(result?.status, 'cancelled');
    await assert.rejects(manager.resolveApproval(session.id, turnId, approvalId, { decision: 'approved' }), /失效/);
    const file = join(directory, `${session.id}.json`);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.turns[0].approvals[0].status, 'cancelled');
    persisted.turns[0].approvals[0].status = 'pending';
    await manager.close();
    await writeFile(file, JSON.stringify(persisted));
    const restarted = new SessionManager({} as CodexClient, directory, defaults, runtime);
    await restarted.init();
    assert.equal(restarted.get(session.id).turns[0].approvals![0].status, 'cancelled');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).turns[0].approvals[0].status, 'cancelled');
    await restarted.close();
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('restart preserves recorded decisions while cancelling every pending request', () => {
  const turn = makeTurn();
  turn.approvals = ['approved', 'pending', 'rejected'].map(status => ({ ...input, id: randomUUID(), status, createdAt: new Date().toISOString() })) as UserApproval[];
  assert.equal(cancelPersistedApprovals(turn), true);
  assert.deepEqual(turn.approvals.map(approval => approval.status), ['approved', 'cancelled', 'rejected']);
  assert.equal(cancelPersistedApprovals(turn), false);
});
