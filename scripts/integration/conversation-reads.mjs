import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// Opt-in live test. Conversations and child threads must come from real model
// turns through CoCell; never create rollout fixtures or run guest commands.
const token = process.env.COCELL_E2E_ACCESS_TOKEN;
const base = new URL(process.env.COCELL_E2E_BASE_URL ?? 'http://127.0.0.1:3001');
assert(token, 'COCELL_E2E_ACCESS_TOKEN is required');
assert(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash,
  'COCELL_E2E_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const model = process.env.COCELL_E2E_MODEL ?? 'gpt-6-luna';
// Reuse an explicitly selected ready project when the cluster cannot schedule
// another Sandbox. This mode only deletes sessions created by this test.
const reuseProjectId = process.env.COCELL_E2E_PROJECT_ID;
const operationTimeout = Number(process.env.COCELL_E2E_OPERATION_TIMEOUT_MS ?? 300_000);
const turnTimeout = Number(process.env.COCELL_E2E_TURN_TIMEOUT_MS ?? 600_000);
const readBudgetMs = Number(process.env.COCELL_E2E_READ_LATENCY_MS ?? 2000);
for (const value of [operationTimeout, turnTimeout, readBudgetMs]) assert(Number.isSafeInteger(value) && value > 0, 'Invalid timeout or latency budget');
const output = resolve(process.env.COCELL_E2E_READ_REPORT ?? `tmp/integration/conversation-reads-${runId}.json`);
const markers = Object.fromEntries(['root', 'child', 'grandchild', 'other', 'followup'].map(name => [name, `${name}-${randomUUID()}`]));
const report = { runId, baseUrl: base.origin, model, readBudgetMs, startedAt: new Date().toISOString(), status: 'running', steps: [] };
let projectId;
const createdSessions = [];
const redact = value => String(value).replaceAll(token, '[redacted]');
const persist = async () => {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
};

async function request(path, { method = 'GET', body, expectedStatus = 200, timeoutMs = 30_000 } = {}) {
  const start = performance.now();
  const response = await fetch(new URL(path, base), { method, redirect: 'manual',
    headers: { Authorization: `Bearer ${token}`, Origin: base.origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  const durationMs = performance.now() - start;
  const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
  assert.equal(response.status, expectedStatus, redact(`${method} ${path}: ${JSON.stringify(data).slice(0, 800)}`));
  return { data, durationMs, bytes: Buffer.byteLength(text) };
}
async function json(path, options) { return (await request(path, options)).data; }
async function step(name, run) {
  const entry = { name, startedAt: new Date().toISOString(), status: 'running' };
  report.steps.push(entry); await persist(); console.log(`[${report.steps.length}] ${name}`);
  const start = performance.now();
  try { entry.evidence = await run(); entry.status = 'passed'; }
  catch (error) { entry.status = 'failed'; entry.error = redact(error.message); throw error; }
  finally { entry.durationMs = performance.now() - start; await persist(); }
  console.log(`    PASS (${Math.round(entry.durationMs)} ms)`);
}
function answer(turn) { return turn.items.filter(item => item.type === 'agent_message').map(item => item.text).join('\n'); }
function transcript(agents) { return agents.flatMap(agent => agent.turns.map(answer)).join('\n'); }
function checkHistory(session, threadId) {
  assert.equal(session.threadId, threadId, 'Native conversation thread changed');
  assert(!session.historyError, session.historyError);
  assert.equal(session.settings.model, model);
  assert(session.turns.length > 0, 'Native history is empty');
}
async function createSession(title) {
  const session = await json('/api/sessions', { method: 'POST', expectedStatus: 201,
    body: { projectId, title, settings: { model, modelReasoningEffort: 'low', webSearchMode: 'disabled' } } });
  assert.equal(session.settings.model, model);
  createdSessions.push(session.id);
  report.testSessionIds = [...createdSessions]; await persist();
  return session.id;
}
async function waitIdle() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await json(`/api/projects/${projectId}`)).activeSessionId) return;
    await delay(300);
  }
  throw new Error('Project still has an active model turn');
}
async function turn(id, prompt) {
  const { turnId } = await json(`/api/sessions/${id}/turns`, { method: 'POST', expectedStatus: 202, body: { prompt, images: [] } });
  const deadline = Date.now() + turnTimeout;
  let previous;
  while (Date.now() < deadline) {
    const session = await json(`/api/sessions/${id}`, { timeoutMs: 60_000 });
    const current = session.turns.find(turn => turn.id === turnId || turn.nativeTurnId === turnId || turn.prompt === prompt);
    if (current) {
      const state = `${current.status}/${current.items.length}`;
      if (state !== previous) { console.log(`    turn ${state}`); previous = state; }
      if (current.status !== 'running') {
        assert.equal(current.status, 'completed', redact(current.error ?? `Turn ended as ${current.status}`));
        assert(session.threadId, 'The model did not create a native thread');
        checkHistory(session, session.threadId);
        assert(!current.items.some(item => ['command_execution', 'file_change'].includes(item.type)),
          'This read-only conversation must not execute commands or change files');
        await waitIdle();
        return { session, current };
      }
    }
    await delay(1500);
  }
  await json(`/api/sessions/${id}/stop`, { method: 'POST', body: {} }).catch(() => {});
  throw new Error(`Model turn timed out; inspect session ${id}`);
}
function nestedPrompt() {
  return `这是对话历史与子代理接口的真实模型集成测试。必须实际使用子代理工具，不能只描述或假装已经委派。你和所有子代理都不得使用 shell、读写文件、联网、安装软件或操作凭证。
本次明确授权委派下面两个很小的支持任务：
1. 你创建一个直属子代理，任务为核对子代理链路。给它完整指令：它必须再创建一个孙代理，孙代理只回复标记 ${markers.grandchild}，不运行任何其他工具；直属子代理等待孙代理完成后，回复自己的标记 ${markers.child} 和孙代理的结果。
2. 你等待直属子代理完成，然后最后回复你自己的标记 ${markers.root} 以及两个子代理的结果。
如工具允许指定模型，请使用准确的小写模型名 ${model}；如允许指定 fork_turns，请使用 none 并传入完整任务指令。务必等待所有子代理完成才结束，不要向用户提问。`;
}
function verifyDescendants(agents, threadId) {
  const child = agents.find(agent => agent.parentThreadId === threadId && agent.turns.some(turn => answer(turn).includes(markers.child)));
  assert(child, 'Missing actual direct-child transcript');
  const grandchild = agents.find(agent => agent.parentThreadId === child.threadId
    && agent.turns.some(turn => answer(turn).includes(markers.grandchild)));
  assert(grandchild, 'Missing actual grandchild transcript');
  assert.notEqual(child.threadId, grandchild.threadId);
  assert.equal(child.depth, 1); assert.equal(grandchild.depth, 2);
  const ancestors = new Set([threadId]);
  let changed;
  do {
    changed = false;
    for (const agent of agents) if (ancestors.has(agent.parentThreadId) && !ancestors.has(agent.threadId)) {
      ancestors.add(agent.threadId); changed = true;
    }
  } while (changed);
  assert.equal(ancestors.size, agents.length + 1, 'Unrelated or duplicate thread leaked into the response');
  for (const agent of agents) {
    assert(Number.isFinite(Date.parse(agent.startedAt))); assert(agent.path);
    assert(agent.turns.length > 0);
    for (const turn of agent.turns) {
      assert.equal(turn.prompt, '', 'Injected subagent prompt was exposed');
      assert.equal(turn.status, 'completed', 'Parent finished before its subagent completed');
      assert(!turn.items.some(item => ['command_execution', 'file_change'].includes(item.type)));
    }
  }
  return agents.map(agent => ({ threadId: agent.threadId, parentThreadId: agent.parentThreadId,
    path: agent.path, depth: agent.depth, turns: agent.turns.length }));
}

try {
  await step(reuseProjectId ? 'Select an existing idle Sandbox project' : 'Create an isolated real Sandbox project', async () => {
    assert.equal((await json('/api/config')).sandbox?.enabled, true);
    if (reuseProjectId) {
      const project = await json(`/api/projects/${encodeURIComponent(reuseProjectId)}`);
      assert.equal(project.status, 'active'); assert.equal(project.sandbox?.status, 'ready');
      assert(!project.activeSessionId, 'Selected project already has an active conversation');
      assert(project.sandboxOperation?.status !== 'running' && project.sandboxOperation?.status !== 'queued', 'Selected project is under maintenance');
      projectId = report.projectId = project.id; report.reusedProject = true; report.sandboxId = project.sandbox.id;
      return { projectId, sandboxId: project.sandbox.id, reusedProject: true };
    }
    const project = await json('/api/projects', { method: 'POST', expectedStatus: 201,
      body: { name: `Read integration ${runId}`, type: 1 } });
    projectId = report.projectId = project.id;
    const deadline = Date.now() + operationTimeout;
    while (Date.now() < deadline) {
      const current = await json(`/api/projects/${projectId}`);
      if (current.sandboxOperation?.status === 'failed') throw new Error(current.sandboxOperation.error);
      if (current.sandboxOperation?.status === 'succeeded') {
        assert.equal(current.sandbox.status, 'ready'); report.sandboxId = current.sandbox.id;
        return { projectId, sandboxId: current.sandbox.id, image: current.sandbox.image?.id };
      }
      await delay(1500);
    }
    throw new Error('Project creation timed out');
  });
  let sessionId, threadId;
  await step('Ask the real model to create a child and grandchild and wait for their replies', async () => {
    sessionId = report.sessionId = await createSession('Nested subagent read integration');
    const { session, current } = await turn(sessionId, nestedPrompt());
    threadId = report.threadId = session.threadId;
    for (const marker of [markers.root, markers.child, markers.grandchild]) assert(answer(current).includes(marker), 'Main response missed a child result');
    const agents = await json(`/api/sessions/${sessionId}/subagents`);
    return { sessionId, threadId, descendants: verifyDescendants(agents, threadId) };
  });
  await step('Create another real subagent conversation in the same project and verify isolation', async () => {
    const otherId = report.otherSessionId = await createSession('Unrelated subagent read integration');
    const { session } = await turn(otherId, `这是另一个会话的隔离测试。必须实际创建一个直属子代理，让它只回复 ${markers.other}。如允许指定模型，使用准确的小写模型名 ${model}。等待它完成，并在最终回复中包含这个标记。你和子代理都不得执行命令、读写文件或联网。`);
    const otherAgents = await json(`/api/sessions/${otherId}/subagents`);
    assert(otherAgents.some(agent => agent.parentThreadId === session.threadId && transcript([agent]).includes(markers.other)), 'Other conversation did not spawn a real child');
    const agents = await json(`/api/sessions/${sessionId}/subagents`);
    verifyDescendants(agents, threadId);
    assert(!transcript(agents).includes(markers.other), 'Other session transcript leaked into the first session');
    assert(!transcript(otherAgents).includes(markers.child), 'First session transcript leaked into the other session');
    return { sessionId: otherId, threadId: session.threadId, agents: otherAgents.map(agent => agent.threadId) };
  });
  await step('Continue the original model conversation and verify fresh native history', async () => {
    const { session, current } = await turn(sessionId, `继续原对话。不要创建新的子代理，不要运行工具。回复本次标记 ${markers.followup}，再复述前一轮中直属子代理与孙代理回复的两个随机标记，确认原对话上下文仍在。`);
    checkHistory(session, threadId);
    for (const marker of [markers.followup, markers.child, markers.grandchild]) assert(answer(current).includes(marker), 'Follow-up lost native conversation context');
    const fresh = await json(`/api/sessions/${sessionId}`); checkHistory(fresh, threadId);
    assert(fresh.turns.some(turn => answer(turn).includes(markers.followup)), 'History served a stale transcript');
    return { threadId, turns: fresh.turns.length };
  });
  await step('Measure five pairs of warm history and subagent HTTP reads', async () => {
    const samples = [];
    for (let index = 0; index < 5; index++) {
      const [history, agents] = await Promise.all([request(`/api/sessions/${sessionId}`), request(`/api/sessions/${sessionId}/subagents`)]);
      checkHistory(history.data, threadId); verifyDescendants(agents.data, threadId);
      assert(history.data.turns.some(turn => answer(turn).includes(markers.followup)));
      samples.push({ historyMs: history.durationMs, subagentsMs: agents.durationMs, historyBytes: history.bytes, subagentsBytes: agents.bytes });
      console.log(`    history ${Math.round(history.durationMs)} ms; subagents ${Math.round(agents.durationMs)} ms`);
    }
    const p95 = key => [...samples].sort((a, b) => a[key] - b[key])[Math.ceil(samples.length * 0.95) - 1][key];
    const historyP95Ms = p95('historyMs'), subagentsP95Ms = p95('subagentsMs');
    // Persist measured samples even when the regression guard fails.
    report.readMeasurements = { samples, historyP95Ms, subagentsP95Ms };
    assert(historyP95Ms <= readBudgetMs, `History p95 ${Math.round(historyP95Ms)} ms exceeds ${readBudgetMs} ms`);
    assert(subagentsP95Ms <= readBudgetMs, `Subagents p95 ${Math.round(subagentsP95Ms)} ms exceeds ${readBudgetMs} ms`);
    return report.readMeasurements;
  });
  if (process.env.COCELL_E2E_KEEP_PROJECT !== '1') await step(reuseProjectId ? 'Delete only sessions created by this test' : 'Delete only this test project', async () => {
    if (reuseProjectId) {
      for (const id of createdSessions) await json(`/api/sessions/${id}`, { method: 'DELETE', timeoutMs: operationTimeout });
      const project = await json(`/api/projects/${projectId}`);
      assert.equal(project.sandbox?.id, report.sandboxId, 'Test cleanup changed the existing Sandbox');
      return { deletedSessionIds: createdSessions, preservedProjectId: projectId };
    }
    await json(`/api/projects/${projectId}`, { method: 'DELETE', timeoutMs: operationTimeout });
    return { deletedProjectId: projectId };
  });
  else report.keptProject = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = redact(error.message); process.exitCode = 1;
  console.error(`FAIL: ${report.error}`);
  if (projectId) console.error(`Preserved project ${projectId} for inspection.`);
} finally {
  report.finishedAt = new Date().toISOString(); await persist();
  console.log(`Result: ${report.status}; report: ${output}`);
}
