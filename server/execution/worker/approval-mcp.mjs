import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const tool = {
  name: 'request_user_approval',
  title: '请求用户同意',
  description: '所有线上变更及任何环境的变更 SQL/DDL，必须先通过此工具获得同意。包括 Apollo 配置修改、发布、回滚及部署、重启、扩缩容等，内部 API/脚本也不例外；用户说“改一下”不代替确认。纯只读查询不需要。用简短白话说明要做什么、改哪里、有何影响。复杂 SQL 或脚本先保存到项目工作区文件，再附查看链接，不在卡片里粘贴长代码。只有 approved=true 才可执行；内容或目标改变须重新确认。此工具不执行操作。',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200, description: '简短说明需要用户同意的操作。' },
      target: { type: 'string', minLength: 1, maxLength: 2000, description: '一行写明环境和目标，如“生产库 orders 表”。不含凭据。' },
      action: { type: 'string', minLength: 1, maxLength: 32000, description: '用一两句话说明具体操作。简单 SQL 可直接附上；复杂 SQL/脚本先保存到项目工作区，再用 [查看脚本](/绝对路径/文件.sql) 提供链接，不粘贴长代码。请求后保持文件内容不变，修改须重新确认。' },
      impact: { type: 'string', minLength: 1, maxLength: 8000, description: '一句话写明影响范围及关键风险，例如“更新 12 行，不删除数据”。未知范围直说，不展开技术细节。' },
    },
    required: ['title', 'target', 'action', 'impact'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};
const pending = new Map();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const fail = message => ({ isError: true, content: [{ type: 'text', text: message }] });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
  let message;
  try { if (Buffer.byteLength(line) > 131072) throw Error(); message = JSON.parse(line); }
  catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON request' } }); return; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) { send({ id: null, error: { code: -32600, message: 'Invalid request' } }); return; }
  if (message.method === 'notifications/cancelled') { pending.get(message.params?.requestId)?.abort(); return; }
  if (message.id === undefined) return;
  const respond = result => send({ id: message.id, result });
  if (message.method === 'initialize') respond({
    protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18',
    capabilities: { tools: {} }, serverInfo: { name: 'swarm-approvals', version: '1.0.0' },
  });
  else if (message.method === 'ping') respond({});
  else if (message.method === 'tools/list') respond({ tools: [tool] });
  else if (message.method === 'tools/call') {
    if (message.params?.name !== tool.name) { respond(fail('Unknown tool')); return; }
    const controller = new AbortController(); pending.set(message.id, controller);
    try {
      const response = await fetch(process.env.SWARM_APPROVAL_URL, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SWARM_APPROVAL_TOKEN}` },
        body: JSON.stringify({ requestId: randomUUID(), input: message.params.arguments }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1_880_000)]),
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !['approved', 'rejected', 'cancelled', 'expired'].includes(result.approval?.status)) {
        respond(fail('未收到有效用户决定，不得执行请求中的操作。')); return;
      }
      const receipt = { ...result.approval, approved: result.approval.status === 'approved' };
      respond({ content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt });
    } catch { respond(fail('请求已取消、超时或连接中断，未获用户同意，不得执行请求中的操作。')); }
    finally { pending.delete(message.id); }
  } else send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
});
lines.on('close', () => { for (const controller of pending.values()) controller.abort(); });
