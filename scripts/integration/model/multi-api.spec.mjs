import assert from 'node:assert/strict';
import { test } from '../support/fixtures.mjs';
import { connectEvents, createConversation, submit, waitFor, finish } from '../support/agent.mjs';

function endpoint(environment, value, label) {
  assert(value, `COCELL_E2E_API_${label}_URL is required for multi-api integration`);
  const base = new URL(value);
  assert(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password
    && !base.search && !base.hash && base.pathname === '/', `COCELL_E2E_API_${label}_URL must be an HTTP(S) origin`);
  const client = Object.create(environment);
  client.config = { ...environment.config, base };
  return client;
}

test('multi-api coordination shares sessions, rejects conflicts, steers a live turn and fans out SSE', async ({ environment }) => {
  const apiA = endpoint(environment, process.env.COCELL_E2E_API_A_URL, 'A');
  const apiB = endpoint(environment, process.env.COCELL_E2E_API_B_URL, 'B');
  assert.notEqual(apiA.config.base.origin, apiB.config.base.origin,
    'Configure distinct direct API URLs or pod forwards; a load balancer cannot prove instance coordination');

  const project = await environment.step('Create a project on API A', async () => {
    const created = await apiA.createProject('multi-api');
    await apiA.waitProject(created.id, { kind: 'create', status: 'ready' });
    return created;
  });
  const session = await environment.step('Create a conversation on API A and read both records from API B', async () => {
    const created = await createConversation(apiA, project, 'Multi API async input');
    const fromB = await apiB.json(`/api/projects/${project.id}`);
    assert.equal(fromB.id, project.id);
    assert.equal(fromB.name, environment.projects.get(project.id));
    const sessionFromB = await apiB.json(`/api/sessions/${created.id}`);
    assert.equal(sessionFromB.id, created.id);
    assert.equal(sessionFromB.projectId, project.id);
    assert.equal(sessionFromB.status, 'idle');
    return created;
  });

  let events = await connectEvents(apiB, session);
  const ownerEvents = await connectEvents(apiA, session);
  try {
    await events.wait(message => message.type === 'snapshot' && message.session.id === session.id);
    const prompt = '请帮我确定 Node.js 健康检查服务的启动方式。请先调用一次原生 request_user_input_async，参数为 {"questions":[{"title":"你希望如何启动 Node.js 健康检查服务？","options":["node server.js","npm start"]}]}。这是异步工具，使用 title 和字符串 options，不要套用同步 request_user_input 的 id/header/question/label/description 格式。收到调用结果后，立即执行命令 `sleep 45`，不要等待我回答后才执行；命令结束后，逐字重复我选择的选项并简短确认。不要调用其他工具，不要开始新的 turn。';
    const { turnId } = await environment.step('Start a native question and long-running command on API A', () => submit(apiA, session, prompt));
    const running = await waitFor(apiB, 'API B observes the question and sleeping command', () => apiB.json(`/api/sessions/${session.id}`), current => {
      const turn = current.turns.find(value => value.id === turnId);
      assert(turn || current.status === 'running', 'Original web turn disappeared before the question could be answered');
      if (turn) assert.equal(turn.status, 'running', apiB.redact(turn.error ?? 'Turn ended before asking the question'));
      return turn?.userInputRequests?.some(request => request.status === 'pending')
        && turn.items.some(item => item.type === 'command_execution' && item.status === 'in_progress' && item.command.includes('sleep 45'));
    });
    const source = running.turns.find(value => value.id === turnId);
    const request = source.userInputRequests.find(value => value.status === 'pending');
    assert.equal(request.questions.length, 1);
    assert.equal(request.questions[0].options?.length, 2);
    const answer = request.questions[0].options[0];
    const threadId = running.threadId;
    const turnCount = running.turns.length;

    await environment.step('API B rejects duplicate execution and Sandbox maintenance during the active turn', async () => {
      await apiB.request(`/api/sessions/${session.id}/turns`, { method: 'POST', body: { prompt, images: [] }, expectedStatus: 409 });
      await apiB.request(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', body: {}, expectedStatus: 409 });
    });

    await environment.step('Answer through API B and receive the shared state update over its SSE connection', async () => {
      await apiB.json(`/api/sessions/${session.id}/turns/${turnId}/user-input/${request.id}`, {
        method: 'POST', body: { answer }, expectedStatus: 200,
      });
      const state = await events.wait(message => message.type === 'state'
        && message.session.turns.some(turn => turn.id === turnId
          && turn.userInputRequests?.some(value => value.id === request.id && value.status === 'answered')));
      const updated = state.session.turns.find(turn => turn.id === turnId);
      assert.equal(updated.status, 'running', 'Answer was accepted before the original turn completed');
      assert.equal(state.session.turns.length, turnCount, 'Answer must not create another turn');
      assert.equal(state.session.threadId, threadId);
      await ownerEvents.wait(message => message.type === 'state'
        && message.session.turns.some(turn => turn.id === turnId
          && turn.userInputRequests?.some(value => value.id === request.id && value.status === 'answered')));
      return { turnId, requestId: request.id, answer };
    });

    const completed = await waitFor(apiB, 'API B observes the same native turn finish', () => apiB.json(`/api/sessions/${session.id}`), current => {
      const turn = current.turns.find(value => value.id === turnId);
      return turn !== undefined && turn.status !== 'running';
    });
    const result = completed.turns.find(value => value.id === turnId);
    assert.equal(result.status, 'completed', apiB.redact(result.error ?? 'Turn failed after receiving the answer'));
    assert.equal(result.prompt, prompt);
    assert.equal(completed.threadId, threadId);
    assert.equal(completed.turns.length, turnCount);
    assert(result.items.some(item => item.type === 'agent_message' && item.text?.includes(answer)));
    await apiA.waitIdle(project.id);
    await environment.step('API B starts the next turn and API A observes its completion', async () => {
      const next = await submit(apiB, session, '只回复：双实例验证完成。不要调用工具。');
      const completedNext = await finish(apiA, session, next.turnId);
      assert(completedNext.text.includes('双实例验证完成'));
      assert.equal(completedNext.session.threadId, threadId);
    });
    environment.report.multiApiEvidence = { apiA: apiA.config.base.origin, apiB: apiB.config.base.origin,
      projectId: project.id, sessionId: session.id, turnId, requestId: request.id, answer, threadId };
    await environment.persist();
  } finally { await Promise.all([events.close(), ownerEvents.close()]); }
});
