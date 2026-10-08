import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

// Real conversations and descendants; never inject history or guest fixture files.
export async function conversationReads(env) {
  const { model, turnTimeout, readBudgetMs } = env.config;
  const report = env.report;
  const json = env.json.bind(env), request = env.request.bind(env), step = env.step.bind(env);
  const redact = env.redact.bind(env), persist = env.persist.bind(env);
  const delay = ms => sleep(ms, undefined, { signal: env.controller.signal });
  const markers = Object.fromEntries(['root', 'child', 'other', 'otherRoot', 'followup'].map(name => [name, `${name}-${randomUUID()}`]));
  let projectId;
  const createdSessions = [];
  const waitIdle = () => env.waitIdle(projectId);
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
  function childPrompt(childMarker = markers.child, rootMarker = markers.root) {
    return `这是对话历史与子代理接口的真实模型集成测试。用户明确授权你创建一个直属子代理，必须实际使用子代理工具，不能只描述或假装已经委派。你和子代理都不得执行命令、读写文件、联网、安装软件或操作凭证。
  只创建一个直属子代理，给它完整独立指令：仅回复随机标记 ${childMarker}，不使用任何工具，不创建任何后代。继承当前模型，不覆盖模型。
  必须等待该子代理完成，并在最终回复中包含你自己的标记 ${rootMarker} 和子代理实际返回的标记。不要向用户提问。派生失败时准确报告工具错误，不得模拟结果。`;
  }
  function verifyChild(agents, threadId, marker = markers.child) {
    assert.equal(agents.length, 1, 'Expected exactly one direct child and no further descendants');
    const child = agents[0];
    assert.equal(child.parentThreadId, threadId, 'Child belongs to another native thread');
    assert.notEqual(child.threadId, threadId);
    assert.equal(child.depth, 1);
    assert(child.turns.some(turn => answer(turn).includes(marker)), 'Missing actual direct-child reply');
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

  await step('Create an isolated real Sandbox project', async () => {
    assert.equal((await json('/api/config')).sandbox?.enabled, true);
    const project = await env.createProject('conversation-reads');
    projectId = report.projectId = project.id;
    const current = await env.waitProject(projectId, { kind: 'create', status: 'ready' });
    report.sandboxId = current.sandbox.id;
    return { projectId, sandboxId: current.sandbox.id, image: current.sandbox.image?.id };
  });
  let sessionId, threadId;
  await step('Ask the real model to create one direct child and wait for its reply', async () => {
    sessionId = report.sessionId = await createSession('Direct subagent read integration');
    const { session, current } = await turn(sessionId, childPrompt());
    threadId = report.threadId = session.threadId;
    const agents = await json(`/api/sessions/${sessionId}/subagents`);
    report.childAgentEvidence = { rootReply: answer(current), agents };
    await persist();
    const descendants = verifyChild(agents, threadId);
    for (const marker of [markers.root, markers.child]) assert(answer(current).includes(marker), `Main response missed a child result; model reply: ${redact(answer(current)).slice(0, 1000)}`);
    return { sessionId, threadId, descendants };
  });
  await step('Create another real subagent conversation in the same project and verify isolation', async () => {
    const otherId = report.otherSessionId = await createSession('Unrelated subagent read integration');
    const { session, current } = await turn(otherId, childPrompt(markers.other, markers.otherRoot));
    const otherAgents = await json(`/api/sessions/${otherId}/subagents`);
    report.isolationAgentEvidence = { rootReply: answer(current), agents: otherAgents };
    await persist();
    verifyChild(otherAgents, session.threadId, markers.other);
    for (const marker of [markers.otherRoot, markers.other]) assert(answer(current).includes(marker), 'Other parent did not return its child result');
    const agents = await json(`/api/sessions/${sessionId}/subagents`);
    verifyChild(agents, threadId);
    assert(!transcript(agents).includes(markers.other), 'Other session transcript leaked into the first session');
    assert(!transcript(otherAgents).includes(markers.child), 'First session transcript leaked into the other session');
    return { sessionId: otherId, threadId: session.threadId, agents: otherAgents.map(agent => agent.threadId) };
  });
  await step('Continue the original model conversation and verify fresh native history', async () => {
    const { session, current } = await turn(sessionId, `继续原对话。不要创建新的子代理，不要运行工具。回复本次标记 ${markers.followup}，再复述前一轮中直属子代理回复的随机标记，确认原对话上下文仍在。`);
    checkHistory(session, threadId);
    for (const marker of [markers.followup, markers.child]) assert(answer(current).includes(marker), 'Follow-up lost native conversation context');
    const fresh = await json(`/api/sessions/${sessionId}`); checkHistory(fresh, threadId);
    assert(fresh.turns.some(turn => answer(turn).includes(markers.followup)), 'History served a stale transcript');
    return { threadId, turns: fresh.turns.length };
  });
  await step('Measure five pairs of warm history and subagent HTTP reads', async () => {
    const samples = [];
    for (let index = 0; index < 5; index++) {
      const [history, agents] = await Promise.all([request(`/api/sessions/${sessionId}`), request(`/api/sessions/${sessionId}/subagents`)]);
      checkHistory(history.data, threadId); verifyChild(agents.data, threadId);
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
  await step('Checkpoint during concurrent native reads, then resume the same conversations', async () => {
    const reads = Array.from({ length: 4 }, (_, index) => request(index % 2
      ? `/api/sessions/${sessionId}/subagents` : `/api/sessions/${sessionId}`, { expectedStatus: [200, 409] }));
    const results = await Promise.allSettled([...reads,
      json(`/api/projects/${projectId}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 202 })]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const accepted = results.at(-1).value;
    const paused = await env.waitProject(projectId, { kind: 'checkpoint', status: 'paused', operationId: accepted.sandboxOperation.id });
    const opened = await json(`/api/projects/${projectId}/open`, { method: 'POST', expectedStatus: 202 });
    const ready = await env.waitProject(projectId, { kind: 'resume', status: 'ready', operationId: opened.sandboxOperation.id });
    assert.equal(ready.sandbox.id, paused.sandbox.id);
    const fresh = await json(`/api/sessions/${sessionId}`);
    checkHistory(fresh, threadId);
    assert(fresh.turns.some(turn => answer(turn).includes(markers.followup)));
    verifyChild(await json(`/api/sessions/${sessionId}/subagents`), threadId);
    return { sandboxId: ready.sandbox.id, checkpointId: accepted.sandboxOperation.id };
  });

}
