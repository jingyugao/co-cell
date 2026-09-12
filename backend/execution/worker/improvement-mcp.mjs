import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const tool = {
  name: 'submit_improvement_proposal',
  description: '提交基于实际工作发现的改进建议，保存到数据库供人工查看。类别自由填写；提交不代表执行授权。只有数据库确认后才返回成功。',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      category: { type: 'string', minLength: 1, maxLength: 120, description: '自由文本分类，例如知识库、沙箱环境、代码实现、开发流程。' },
      title: { type: 'string', minLength: 1, maxLength: 200, description: '一句话概括建议。' },
      observation: { type: 'string', minLength: 1, maxLength: 8000, description: '实际发现的问题及依据。' },
      proposal: { type: 'string', minLength: 1, maxLength: 16000, description: '具体的改进办法。' },
      expected_benefit: { type: 'string', minLength: 1, maxLength: 4000, description: '预期收益。' },
    },
    required: ['category', 'title', 'observation', 'proposal', 'expected_benefit'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};
const optimizationTool = {
  ...tool,
  name: 'submit_optimization',
  title: '优化建议',
  description: '提交优化建议，专门用于完善知识库或沙箱环境，保存到数据库供人工查看，不直接修改文档或沙箱。知识库优先完善两份文件：~/.codex/docs/project-overview.md（项目与集群简介，记录完整仓库名称、服务职责、业务边界和跨仓库关系）；~/.codex/docs/key-modules.md（重点模块简介，记录模块涉及的项目、关键业务流程、业务规则和上下游依赖）。结合本轮已查阅的相关条目，针对有价值的缺失、过时或错误内容提出补充或修正，提供代码或已有文档依据及可直接收录的正文。优先记录能减少后续业务理解和跨仓库调查成本的内容，不仅罗列目录、入口、版本号或简单启动命令。沙箱建议基于实际遇到的工具、版本或系统依赖问题，说明适合平台统一解决的原因和验证办法。仅使用当前任务已取得的证据，无有价值的增量则不提交，不要求每轮使用；不提交凭据，不重复提交。只有数据库确认后才能说建议已提交，不能声称知识库或沙箱已更新。',
  inputSchema: {
    ...tool.inputSchema,
    properties: {
      ...tool.inputSchema.properties,
      category: { ...tool.inputSchema.properties.category, description: '自由文本分类，例如知识库/代码仓库介绍、知识库/业务模块介绍、沙箱环境；不限定枚举。' },
      observation: { ...tool.inputSchema.properties.observation, description: '知识库：说明已查阅的 project-overview.md 或 key-modules.md 相关章节、具体缺失或错误，以及代码或文档依据。沙箱：提供实际遇到的错误、版本或依赖证据。区分已确认事实和待确认事项，不包含凭据。' },
      proposal: { ...tool.inputSchema.properties.proposal, description: '知识库：优先注明目标文件 data/docs/project-overview.md 或 data/docs/key-modules.md、拟新增或修改的章节及可直接收录的正文，说明仓库职责、模块业务流程、规则或跨仓库关系，附关键代码路径。沙箱：建议的环境变更、适用范围和验证命令。不要只写“建议补文档”或“安装工具”。' },
      expected_benefit: { ...tool.inputSchema.properties.expected_benefit, description: '说明能帮助后续任务理解哪些业务、减少哪些重复调查，或解除哪些实际环境阻碍。' },
    },
  },
};
const availableTools = [tool, optimizationTool];
const pending = new Map();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const errorResult = message => ({ isError: true, content: [{ type: 'text', text: message }] });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
  let message;
  try {
    if (Buffer.byteLength(line) > 131072) throw new Error('Request too large');
    message = JSON.parse(line);
  } catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON request' } }); return; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    send({ id: null, error: { code: -32600, message: 'Invalid request' } }); return;
  }
  if (message.method === 'notifications/cancelled') { pending.get(message.params?.requestId)?.abort(); return; }
  if (message.id === undefined) return;
  const respond = result => send({ id: message.id, result });
  if (message.method === 'initialize') {
    respond({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion)
      ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: {} },
    serverInfo: { name: 'swarm-improvements', version: '1.0.0' } });
  } else if (message.method === 'ping') respond({});
  else if (message.method === 'tools/list') respond({ tools: availableTools });
  else if (message.method === 'tools/call') {
    if (!availableTools.some(entry => entry.name === message.params?.name)) { respond(errorResult('Unknown tool')); return; }
    const controller = new AbortController();
    pending.set(message.id, controller);
    try {
      const response = await fetch(process.env.SWARM_IMPROVEMENT_URL, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SWARM_IMPROVEMENT_TOKEN}` },
        body: JSON.stringify({ requestId: randomUUID(), input: message.params.arguments }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(50_000)]),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) respond(errorResult(result.error || '未收到数据库保存确认，请稍后在建议页面核实。'));
      else respond({ content: [{ type: 'text', text: JSON.stringify(result.receipt) }], structuredContent: result.receipt });
    } catch { respond(errorResult('未收到数据库保存确认（连接中断、取消或超时），请在建议页面核实，不能声称已提交成功。')); }
    finally { pending.delete(message.id); }
  } else send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
});
lines.on('close', () => { for (const controller of pending.values()) controller.abort(); });
