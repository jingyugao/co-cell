import assert from 'node:assert/strict';
import { createConversation, runAgent, waitFor } from '../support/agent.mjs';

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
    for (const turn of [source, reply]) assert(!turn.items.some(item =>
      ['command_execution', 'file_change', 'mcp_tool_call'].includes(item.type)), 'Question must use the native asynchronous input tool');
    env.report.userInputEvidence.reply = reply;
    await env.persist();
    return { requestId: request.id, answerTurnId: reply.id, selectedAnswer };
  });
}
