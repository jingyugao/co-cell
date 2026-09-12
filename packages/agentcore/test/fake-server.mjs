import { createInterface } from 'node:readline';
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
 const message = JSON.parse(line);
 if (message.method === 'initialize') send({ id: message.id, result: {} });
 else if (message.method === 'echo') send({ id: message.id, result: message.params });
 else if (message.method === 'burst') {
  send({ method: 'notice', params: { value: 1 } });
  send({ id: message.id, result: {} });
 } else if (message.method === 'serverRequest') {
  send({ id: 'server-1', method: 'approval', params: {} });
  send({ id: message.id, result: {} });
 } else if (message.id === 'server-1') send({ method: 'serverResponse', params: message });
 else if (message.method === 'die') process.exit(7);
 else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId ?? 'thread-1' } } });
 else if (message.method === 'turn/start') {
  send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'turn-1' } } });
  send({ method: 'item/started', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', text: '' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId: 'turn-1', itemId: 'item-1', delta: 'hello' } });
  send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', text: 'hello' } } });
  send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'turn-1', status: 'completed' } } });
  send({ id: message.id, result: { turn: { id: 'turn-1' } } });
 }
}
