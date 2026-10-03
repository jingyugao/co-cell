import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userInputReplyDisplayText } from './user-input.js';

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
