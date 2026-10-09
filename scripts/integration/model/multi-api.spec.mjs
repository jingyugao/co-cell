import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

function eventContains(message, marker) {
  return message?.type === 'sdk' && JSON.stringify(message.event).includes(marker);
}

test('multi-api coordination streams native events, steers a live turn and isolates concurrent threads', async ({ environment }) => {
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
  const otherSession = await environment.step('Create a second independent conversation in the same project',
    () => createConversation(apiB, project, 'Concurrent native thread'));

  let events = await connectEvents(apiB, session);
  const ownerEvents = await connectEvents(apiA, session);
  let otherEvents = await connectEvents(apiA, otherSession);
  try {
    await events.wait(message => message.type === 'snapshot' && message.session.id === session.id);
    const firstText = `native-stream-${randomUUID()}`;
    const appendedText = `steered-${randomUUID()}`;
    const otherText = `parallel-thread-${randomUUID()}`;
    const prompt = `请先在对话中原样输出标记 ${firstText}，然后帮我确定 Node.js 健康检查服务的启动方式。请调用一次原生 request_user_input_async，参数为 {"questions":[{"title":"你希望如何启动 Node.js 健康检查服务？","options":["node server.js","npm start"]}]}。这是异步工具，使用 title 和字符串 options，不要套用同步 request_user_input 的 id/header/question/label/description 格式。收到调用结果后，立即执行命令 \`sleep 45\`，不要等待我回答后才执行；命令结束后，逐字重复我选择的选项并简短确认。不要调用其他工具，不要开始新的 turn。`;
    const { turnId } = await environment.step('Start a native question and long-running command on API A', () => submit(apiA, session, prompt));
    const runningSamples = [];
    let previousSample = '';
    const rememberRunningSample = current => {
      const sample = {
        at: new Date().toISOString(), status: current.status, threadId: current.threadId,
        turns: current.turns.map(turn => ({
          id: turn.id, nativeTurnId: turn.nativeTurnId, status: turn.status,
          userInputRequests: (turn.userInputRequests ?? []).map(request => ({ id: request.id, status: request.status,
            questions: request.questions.map(question => ({ title: question.title, options: question.options?.length ?? 0 })) })),
          items: turn.items.slice(-24).map(item => ({ type: item.type, status: 'status' in item ? item.status : undefined,
            delivery: item.type === 'agent_message' ? item.delivery : undefined,
            questions: item.type === 'agent_message' ? item.questions?.map(question => ({ title: question.title,
              options: question.options?.length ?? 0 })) : undefined })),
        })),
        sse: Object.fromEntries(['sdk', 'state', 'snapshot'].map(type => [type,
          events.messages.filter(message => message.type === type).length])),
      };
      const signature = JSON.stringify({ ...sample, at: undefined });
      if (signature !== previousSample) {
        previousSample = signature;
        if (runningSamples.length === 12) runningSamples.shift();
        runningSamples.push(sample);
        console.log('[multi-api-observe]', JSON.stringify({ at: sample.at, status: sample.status, threadId: sample.threadId,
          turns: sample.turns.map(turn => ({ id: turn.id, nativeTurnId: turn.nativeTurnId, status: turn.status,
            userInputRequests: turn.userInputRequests.map(request => ({ id: request.id, status: request.status })),
            commands: turn.items.filter(item => item.type === 'command_execution').map(item => ({ status: item.status })) })),
          sse: sample.sse }));
      }
      environment.report.multiApiDiagnostics = { stage: 'wait for native async question and sleep command', runningSamples };
    };
    const running = await waitFor(apiB, 'API B observes the question and sleeping command', () => apiB.json(`/api/sessions/${session.id}`), current => {
      rememberRunningSample(current);
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

    await environment.step('API B receives live native text and steers the existing turn', async () => {
      await events.wait(message => eventContains(message, firstText));
      const steered = await submit(apiB, session, `睡眠命令结束后，也请在最终回答中包含标记 ${appendedText}。`);
      assert.equal(steered.turnId, turnId, 'Steering must return the existing CoCell turn ID');
      const state = await events.wait(message => message.type === 'state'
        && message.session.turns.some(turn => turn.id === turnId && turn.additionalUserInputs?.some(input => input.includes(appendedText))));
      assert.equal(state.session.turns.length, turnCount, 'Steering must not create another turn');
      return { turnId: steered.turnId, firstTextObserved: true, appendedText };
    });

    const otherSubmission = await environment.step('A separate thread starts while the first thread is still running', async () => {
      const { turnId: otherTurnId } = await submit(apiB, otherSession,
        `请运行一个前台命令 \`sleep 10\`，结束后只回复 ${otherText}。不要调用其他工具。`);
      const overlap = await waitFor(apiA, 'both native threads are running at the same time', async () => ({
        first: await apiA.json(`/api/sessions/${session.id}`),
        second: await apiA.json(`/api/sessions/${otherSession.id}`),
      }), current => current.first.turns.some(turn => (turn.id === turnId || turn.nativeTurnId === turnId) && turn.status === 'running')
        && current.second.turns.some(turn => (turn.id === otherTurnId || turn.nativeTurnId === otherTurnId)
          && turn.status === 'running' && turn.items.some(item => item.type === 'command_execution'
            && item.status === 'in_progress' && item.command.includes('sleep 10'))));
      const ownToolEvent = await otherEvents.wait(message => eventContains(message, 'sleep 10'));
      assert.equal(ownToolEvent.type, 'sdk');
      assert(events.messages.every(message => !eventContains(message, 'sleep 10') && !eventContains(message, otherText)),
        'The first thread received a native event from the second thread');
      assert(overlap.first.turns.some(turn => turn.id === turnId || turn.nativeTurnId === turnId)
        && overlap.second.turns.some(turn => turn.id === otherTurnId || turn.nativeTurnId === otherTurnId));
      return { otherTurnId, threadId: overlap.second.threadId };
    });

    await environment.step('API B reconnects and reconstructs the current native thread history', async () => {
      await events.close(); events = await connectEvents(apiB, session);
      const snapshot = await events.wait(message => message.type === 'snapshot' && message.session.id === session.id);
      const observed = await waitFor(apiB, 'reconnected API B reads native turn state',
        () => apiB.json(`/api/sessions/${session.id}`), current => current.turns.some(turn =>
          (turn.id === turnId || turn.nativeTurnId === turnId) && turn.status === 'running'
          && turn.items.some(item => item.type === 'agent_message' && item.text?.includes(firstText))));
      assert.equal(snapshot.session.threadId, threadId);
      assert(observed.turns.some(turn => (turn.id === turnId || turn.nativeTurnId === turnId)
        && turn.additionalUserInputs?.some(input => input.includes(appendedText))));
      return { threadId, turnId, historyTurns: observed.turns.length };
    });

    await environment.step('API B blocks Sandbox maintenance during the active turn', async () => {
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
    await environment.step('The concurrent thread completes with isolated native history', async () => {
      const otherCompleted = await waitFor(apiA, 'second native thread completes',
        () => apiA.json(`/api/sessions/${otherSession.id}`), current => current.turns.some(turn =>
          (turn.id === otherSubmission.otherTurnId || turn.nativeTurnId === otherSubmission.otherTurnId) && turn.status !== 'running'));
      const otherTurn = otherCompleted.turns.find(turn => turn.id === otherSubmission.otherTurnId
        || turn.nativeTurnId === otherSubmission.otherTurnId);
      assert.equal(otherTurn.status, 'completed', apiA.redact(otherTurn.error ?? 'Concurrent thread failed'));
      assert(otherTurn.items.some(item => item.type === 'agent_message' && item.text?.includes(otherText)),
        'The concurrent native thread did not complete its own response');
      assert(otherEvents.messages.some(message => eventContains(message, otherText)),
        'The second thread did not receive its own native text event');
      assert(events.messages.every(message => !eventContains(message, otherText)),
        'The first thread received a native event from the second thread');
      return { otherTurnId: otherSubmission.otherTurnId, threadId: otherCompleted.threadId };
    });
    await apiA.waitIdle(project.id);
    await environment.step('API B starts the next turn and API A observes its completion', async () => {
      const next = await submit(apiB, session, '只回复：双实例验证完成。不要调用工具。');
      const completedNext = await finish(apiA, session, next.turnId);
      assert(completedNext.text.includes('双实例验证完成'));
      assert.equal(completedNext.session.threadId, threadId);
    });
    environment.report.multiApiEvidence = { apiA: apiA.config.base.origin, apiB: apiB.config.base.origin,
      projectId: project.id, sessionId: session.id, concurrentSessionId: otherSession.id,
      turnId, requestId: request.id, answer, threadId, firstText, appendedText };
    await environment.persist();
  } finally { await Promise.all([events.close(), ownerEvents.close(), otherEvents.close()]); }
});
