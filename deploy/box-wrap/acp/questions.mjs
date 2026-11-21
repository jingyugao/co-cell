import { createInterface } from 'node:readline';

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const schema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array', minItems: 1, maxItems: 3,
      items: { type: 'object', properties: {
        title: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
      }, required: ['title'] },
    },
  },
  required: ['questions'],
};
createInterface({ input: process.stdin }).on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  let result;
  try {
    switch (message.method) {
      case 'initialize':
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cocell-user-input', version: '1' } };
        break;
      case 'tools/list':
        result = { tools: [{ name: 'request_user_input_async', description: 'Ask the user up to three questions without waiting for a reply. Continue working after the tool returns. The reply will arrive as a later user message.', inputSchema: schema }] };
        break;
      case 'tools/call': {
        if (message.params?.name !== 'request_user_input_async') throw new Error('Unknown tool');
        const response = await fetch(process.env.COCELL_QUESTION_URL, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.COCELL_QUESTION_TOKEN}` },
          body: JSON.stringify(message.params.arguments), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('Could not record the question');
        const value = await response.json();
        result = { content: [{ type: 'text', text: `Questions recorded with ID ${value.id}. Continue without waiting for the user.` }] };
        break;
      }
      default: result = {};
    }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: String(error.message || error) }] } });
  }
});
