import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Session, Settings, Turn } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { SessionManager, type CodexClient } from './manager.js';

const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/user/workspace', model: 'test',
  modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await tick(); }
  assert.fail('timed out');
}

test('an async answer waits for the current turn and is not duplicated after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-user-input-'));
  let releaseFirst!: () => void;
  const firstTurn = new Promise<void>(resolve => { releaseFirst = resolve; });
  let launches = 0;
  const runtime = {
    async close() {},
    async *run(_session: Session, _turn: Turn, _signal: AbortSignal, onSandbox: (value: Session['sandbox']) => Promise<void>) {
      launches++;
      await onSandbox({ id: 'test-sandbox', template: 'test', status: 'ready', workingDirectory: defaults.workingDirectory });
      yield { type: 'thread.started' as const, thread_id: randomUUID() };
      yield { type: 'turn.started' as const, turn_id: randomUUID() };
      if (launches === 1) await firstTurn;
      yield { type: 'turn.completed' as const, usage: { input_tokens: 1, cached_input_tokens: 0,
        cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
    },
  } as unknown as SandboxRuntime;
  const first = new SessionManager({} as CodexClient, directory, defaults, runtime);
  let second: SessionManager | undefined;
  try {
    await first.init();
    const session = await first.create();
    const sourceTurnId = await first.startTurn(session.id, 'Ask me a question');
    await until(() => launches === 1);
    const requestId = randomUUID();
    await first.requestUserInput(session.id, sourceTurnId, session.projectId ?? null, requestId,
      [{ title: 'Which environment?', options: ['UAT', 'Production'] }]);
    const queued = await first.answerUserInput(session.id, sourceTurnId, requestId, 'UAT');
    assert.equal(queued.turns[0].userInputRequests?.[0].status, 'queued');
    assert.equal(queued.turns.length, 1);
    releaseFirst();
    await until(() => first['lookup'](session.id).turns.length === 2 && first['lookup'](session.id).turns[1].status === 'completed');
    assert.equal(first['lookup'](session.id).turns[1].prompt, 'UAT');
    assert.equal(first['lookup'](session.id).turns[0].userInputRequests?.[0].status, 'answered');
    await first.waitForIdle(session.id);
    await first.close();

    // Simulate a crash after the answer turn was saved but before its receipt.
    const path = join(directory, `${session.id}.json`);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Session;
    persisted.turns[0].userInputRequests![0].status = 'queued';
    delete persisted.turns[0].userInputRequests![0].answerTurnId;
    await writeFile(path, JSON.stringify(persisted));
    second = new SessionManager({} as CodexClient, directory, defaults, runtime);
    await second.init();
    await until(() => second!['lookup'](session.id).turns[0].userInputRequests?.[0].status === 'answered');
    assert.equal(second['lookup'](session.id).turns.length, 2);
    assert.equal(second['lookup'](session.id).turns[0].userInputRequests?.[0].answerTurnId, persisted.turns[1].id);
    assert.equal(launches, 2);
  } finally {
    releaseFirst();
    await first.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
