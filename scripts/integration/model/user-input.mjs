import assert from 'node:assert/strict';
import { createConversation, runAgent, submit, waitFor } from '../support/agent.mjs';

export async function asynchronousUserInput(env) {
  const project = await env.createProject('async-input');
  await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  const session = await createConversation(env, project, 'Native asynchronous input');
  let source, request, threadId, selectedAnswer;
  await env.step('Ask one native asynchronous question and persist its actual options', async () => {
    const prompt = '请帮我确定 Node.js 健康检查服务的启动方式。现在缺少我的偏好，请调用一次原生 request_user_input_async，提出一个问题并给出两个不同的启动方式选项。不要执行命令、读写文件、使用同步提问或 MCP。调用后结束本轮，等待异步回答。收到回答后简短确认我实际选择的选项，不要调用其他工具。';
    const result = await runAgent(env, session, prompt);
    source = result.turn; threadId = result.session.threadId;
    env.report.userInputEvidence = { prompt, threadId, source };
    await env.persist();
    assert.equal(source.prompt, prompt);
    assert.equal(source.userInputRequests?.length, 1, 'Expected one persisted native question');
    request = source.userInputRequests[0];
    assert(request.id); assert.equal(request.status, 'pending');
    assert.equal(request.questions.length, 1);
    const question = request.questions[0];
    assert(question.title.trim());
    assert.equal(question.options?.length, 2);
    assert(question.options.every(option => typeof option === 'string' && option.trim()));
    assert.equal(new Set(question.options).size, 2);
    selectedAnswer = question.options[0];
    const native = source.items.find(item => item.id === request.id);
    assert.equal(native?.type, 'agent_message');
    assert.equal(native.delivery, 'async');
    assert.deepEqual(native.questions, request.questions);
    const reloaded = await env.json(`/api/sessions/${session.id}`);
    assert.deepEqual(reloaded.turns.find(turn => turn.id === source.id)?.userInputRequests, source.userInputRequests,
      'Pending question changed on reload');
    return { requestId: request.id, questions: request.questions };
  });
  await env.step('Answer the actual option and verify delivery, continuation and persistence', async () => {
    await env.json(`/api/sessions/${session.id}/turns/${source.id}/user-input/${request.id}`, {
      method: 'POST', body: { answer: selectedAnswer }, expectedStatus: 200,
    });
    const getSaved = current => current.turns.find(turn => turn.id === source.id)?.userInputRequests?.find(value => value.id === request.id);
    await waitFor(env, 'native answer delivered', () => env.json(`/api/sessions/${session.id}`), current => getSaved(current)?.status === 'answered');
    await env.waitIdle(project.id);
    const reloaded = await env.json(`/api/sessions/${session.id}`);
    assert.equal(reloaded.threadId, threadId);
    const saved = getSaved(reloaded);
    assert.equal(saved?.status, 'answered');
    assert.deepEqual(saved.questions, request.questions);
    assert(saved.answerTurnId);
    const reply = reloaded.turns.find(turn => turn.id === saved.answerTurnId);
    assert.equal(reply?.status, 'completed');
    const payload = JSON.parse(reply.prompt.match(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/)?.[1] ?? 'null');
    assert(Array.isArray(payload));
    assert(payload.some(item => item.answer === selectedAnswer && JSON.parse(item.questionItemId)[1] === request.id),
      'Persisted answer lost its selected option or native request association');
    assert(reply.items.some(item => item.type === 'agent_message' && item.text?.trim()), 'Agent did not continue after receiving the answer');
    env.report.userInputEvidence.reply = reply;
    await env.persist();
    return { requestId: request.id, answerTurnId: reply.id, selectedAnswer };
  });

  await env.step('Answer a native question while its turn is running', async () => {
    const liveSession = await createConversation(env, project, 'Native asynchronous input during a running turn');
    const prompt = '请帮我确定 Node.js 健康检查服务的启动方式。请先调用一次原生 request_user_input_async，参数为 {"questions":[{"title":"你希望如何启动 Node.js 健康检查服务？","options":["node server.js","npm start"]}]}。这是异步工具，使用 title 和字符串 options，不要套用同步 request_user_input 的 id/header/question/label/description 格式。收到调用结果后，立即执行命令 `sleep 30`，不要等待我回答后才执行；命令结束后，逐字重复我选择的选项并简短确认。不要调用其他工具，不要开始新的 turn。';
    const { turnId } = await submit(env, liveSession, prompt);
    const running = await waitFor(env, 'native question and long-running command in the same turn', async () => {
      const current = await env.json(`/api/sessions/${liveSession.id}`);
      env.report.userInputEvidence.inFlightObservation = current;
      return current;
    }, current => {
      const turn = current.turns.find(value => value.id === turnId);
      if (turn) assert.equal(turn.status, 'running', env.redact(turn.error ?? 'Turn ended before producing a native question and running the command'));
      return turn?.status === 'running'
        && turn.userInputRequests?.some(value => value.status === 'pending')
        && turn.items.some(item => item.type === 'command_execution' && item.status === 'in_progress' && item.command.includes('sleep 30'));
    });
    const source = running.turns.find(value => value.id === turnId);
    const request = source.userInputRequests.find(value => value.status === 'pending');
    assert.equal(source.userInputRequests.length, 1, 'Expected one native question in the running turn');
    assert.equal(request.questions.length, 1);
    assert.equal(request.questions[0].options?.length, 2);
    const selectedAnswer = request.questions[0].options[0];
    const turnCount = running.turns.length;
    const threadId = running.threadId;

    await env.json(`/api/sessions/${liveSession.id}/turns/${turnId}/user-input/${request.id}`, {
      method: 'POST', body: { answer: selectedAnswer }, expectedStatus: 200,
    });
    const answered = await waitFor(env, 'answer accepted before native turn completion', () => env.json(`/api/sessions/${liveSession.id}`), current => {
      const turn = current.turns.find(value => value.id === turnId);
      return turn?.userInputRequests?.find(value => value.id === request.id)?.status === 'answered';
    });
    const answeredTurn = answered.turns.find(value => value.id === turnId);
    assert.equal(answeredTurn.status, 'running', 'The answer must be accepted while the original turn is still running');
    assert.equal(answered.turns.length, turnCount, 'Answering during a turn must not create a separate reply turn');
    assert.equal(answered.threadId, threadId);

    const completed = await waitFor(env, 'same native turn continued after an in-flight answer', () => env.json(`/api/sessions/${liveSession.id}`), current => {
      const turn = current.turns.find(value => value.id === turnId);
      return turn !== undefined && turn.status !== 'running';
    });
    const continued = completed.turns.find(value => value.id === turnId);
    assert.equal(continued.status, 'completed', env.redact(continued.error ?? 'Native turn failed after receiving the answer'));
    assert.equal(completed.turns.length, turnCount, 'Continuation must remain in the original turn');
    assert.equal(completed.threadId, threadId);
    const saved = continued.userInputRequests.find(value => value.id === request.id);
    assert.equal(saved?.status, 'answered');
    assert.equal(continued.prompt, prompt, 'Native history replaced the original user prompt with an injected answer');
    assert([continued.id, continued.nativeTurnId].includes(saved.answerTurnId),
      'The answer must be associated with the same native turn after history reload');
    assert(continued.items.some(item => item.type === 'agent_message' && item.text?.includes(selectedAnswer)),
      'The original turn did not continue using the selected answer');
    await env.waitIdle(project.id);
    env.report.userInputEvidence.inFlight = { prompt, threadId, turnId, requestId: request.id, selectedAnswer, turn: continued };
    await env.persist();
    return { turnId, requestId: request.id, selectedAnswer, statusBeforeCompletion: answeredTurn.status };
  });
}
