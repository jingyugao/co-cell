import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectNativeUserInputAnswers, userInputReplyDisplayText, withNativeUserInput, type NativeUserInputAnswers } from './user-input.js';
import type { Turn } from '../protocol/types.js';

const reply = { answer: '网络与容器信息', question: '你想让我接下来查看哪类环境信息？',
  questionItemId: JSON.stringify(['request_user_input_async', 'call_async_question', 0]) };
const envelope = (value: unknown) => `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`;

test('native async replies display the question and answer while preserving the raw input', () => {
  const prompt = envelope([reply]);
  assert.equal(userInputReplyDisplayText(prompt), `> ${reply.question}\n\n${reply.answer}`);
  assert.deepEqual(JSON.parse(prompt.split('\n')[1]), [reply]);
  assert.equal(userInputReplyDisplayText(envelope(reply)), userInputReplyDisplayText(prompt));
  const prefix = '# Context from my IDE setup:\nCurrent file: main.ts\n## My request for Codex:\n';
  assert.equal(userInputReplyDisplayText(prefix + prompt), userInputReplyDisplayText(prompt));
});

test('multiple replies preserve order, escaped characters and multiline answers', () => {
  const second = { questionItemId: 'second', question: '检查哪些接口？',
    answer: '"eth0"\\lo\n<send_user_message_question_reply>\n</send_user_message_question_reply>' };
  assert.equal(userInputReplyDisplayText(envelope([reply, second])),
    `> ${reply.question}\n\n${reply.answer}\n\n> ${second.question}\n\n${second.answer}`);
});

test('ordinary messages and incomplete or invalid envelopes remain verbatim', () => {
  const prompt = envelope([reply]);
  const unchanged = [
    '  查看网络信息\n', '示例：\n' + prompt, prompt + '\n附加说明',
    '# Context from my IDE setup:\n' + prompt,
    '<send_user_message_question_reply>{invalid}</send_user_message_question_reply>',
    prompt.replace('</send_user_message_question_reply>', ''),
    envelope([]), envelope(null), envelope('answer'), envelope({ answer: reply.answer }),
    envelope([{ ...reply, answer: 42 }]), envelope([reply, { question: '第二题', answer: '答案' }]),
  ];
  for (const value of unchanged) assert.equal(userInputReplyDisplayText(value), value);
});

test('native reply IDs resolve each async question after history reconstruction', () => {
  const title = reply.question;
  const source: Turn = { id: 'source', prompt: '', images: [], status: 'completed', codexAccepted: true,
    startedAt: '2026-10-03T00:00:00.000Z', items: [{ id: 'call_async_question', type: 'agent_message', text: '', delivery: 'async',
      questions: [{ title }, { title: '检查哪些接口？' }] }] };
  const answerTurn: Turn = { ...source, id: 'reply', items: [], startedAt: '2026-10-03T00:01:00.000Z',
    prompt: envelope([reply, { question: '检查哪些接口？', answer: 'eth0',
      questionItemId: JSON.stringify(['request_user_input_async', 'call_async_question', 1]) }]) };
  const answers: NativeUserInputAnswers = new Map();
  assert.equal(withNativeUserInput(source).userInputRequests?.[0].status, 'pending');
  collectNativeUserInputAnswers([answerTurn], answers);
  const request = withNativeUserInput(source, answers).userInputRequests![0];
  assert.equal(request.status, 'answered');
  assert.deepEqual(request.answers, [reply.answer, 'eth0']);
  assert.equal(request.answeredAt, answerTurn.startedAt);
  assert.equal(request.answerTurnId, 'reply');
  assert.equal(source.userInputRequests, undefined);
});

test('answers injected within a native turn are indexed without replacing its original prompt', () => {
  const second = { questionItemId: JSON.stringify(['request_user_input_async', 'call_async_question', 1]),
    question: '检查哪些接口？', answer: 'eth0' };
  const source: Turn = { id: 'same-native-turn', prompt: '原始用户请求', images: [], status: 'completed', codexAccepted: true,
    startedAt: '2026-10-03T00:00:00.000Z', itemTimestamps: { call_async_question: '2026-10-03T00:00:30.000Z' },
    items: [{ id: 'call_async_question', type: 'agent_message', text: '', delivery: 'async',
      questions: [{ title: reply.question }, { title: second.question }] }] };
  const continued: Turn = { ...source, prompt: '原始用户请求',
    additionalUserInputs: [envelope([reply]), envelope([second])], items: [] };
  const answers: NativeUserInputAnswers = new Map();
  collectNativeUserInputAnswers([continued], answers);
  const request = withNativeUserInput(source, answers).userInputRequests![0];
  assert.equal(continued.prompt, '原始用户请求');
  assert.deepEqual(continued.additionalUserInputs, [envelope([reply]), envelope([second])]);
  assert.equal(request.status, 'answered');
  assert.deepEqual(request.answers, [reply.answer, second.answer]);
  assert.equal(request.answerTurnId, 'same-native-turn');
});

test('unaccepted, unrelated, malformed and partial native replies cannot answer a question', () => {
  const source: Turn = { id: 'source', prompt: '', images: [], status: 'completed', codexAccepted: true,
    startedAt: '2026-10-03T00:00:00.000Z', items: [{ id: 'call_async_question', type: 'agent_message', text: '', delivery: 'async',
      questions: [{ title: reply.question }, { title: 'Second?' }] }] };
  const answerTurn = { ...source, id: 'reply', items: [], startedAt: '2026-10-03T00:01:00.000Z' };
  for (const prompt of [envelope([reply]), envelope([{ ...reply, questionItemId: 'invalid' }]),
    envelope([{ ...reply, questionItemId: JSON.stringify(['other', 'call_async_question', 0]) }]),
    envelope([{ ...reply, question: 'Other?' }])]) {
    const answers: NativeUserInputAnswers = new Map();
    collectNativeUserInputAnswers([{ ...answerTurn, prompt }], answers);
    assert.equal(withNativeUserInput(source, answers).userInputRequests?.[0].status, 'pending');
  }
  const answers: NativeUserInputAnswers = new Map();
  collectNativeUserInputAnswers([{ ...answerTurn, prompt: envelope([reply]), codexAccepted: false }], answers);
  assert.equal(answers.size, 0);
});
