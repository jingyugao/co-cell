import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { UserApproval, UserApprovalInput } from '../../protocol/approval-types.js';
import type { UserInputQuestion, UserInputRequest } from '../../protocol/user-input-types.js';
import type { SessionManager } from '../sessions/manager.js';

export type ApprovalMcpContext = { sessionId: string; turnId: string; projectId: string | null };
type RequestApproval = (context: ApprovalMcpContext, input: UserApprovalInput, requestId: string, signal: AbortSignal) => Promise<UserApproval>;
type RequestUserInput = (context: ApprovalMcpContext, questions: UserInputQuestion[], requestId: string) => Promise<UserInputRequest>;

export const approvalInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  target: z.string().trim().min(1).max(2000),
  action: z.string().min(1).max(32_000).refine(value => value.trim().length > 0),
  impact: z.string().trim().min(1).max(8000),
}).strict();

const tool = {
  name: 'request_user_approval',
  title: '请求用户同意',
  description: '一切线上变更或高风险操作都必须先用此工具取得人工同意，所有变更 SQL/DDL 也适用。工具会等待用户决定，但不执行操作；只有返回 approved=true 才能执行本次展示的内容。内容或目标改变须重新审核。纯只读、无副作用查询无需审核。',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200, description: '简短说明需要审批的操作。' },
      target: { type: 'string', minLength: 1, maxLength: 2000, description: '一行写明环境和目标，不含凭据。' },
      action: { type: 'string', minLength: 1, maxLength: 32000, description: '具体操作；复杂脚本先保存到工作区并提供文件链接。提交后不得修改，修改须重新审批。' },
      impact: { type: 'string', minLength: 1, maxLength: 8000, description: '影响范围和关键风险；未知范围应明确说明。' },
    },
    required: ['title', 'target', 'action', 'impact'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const userInputSchema = z.object({ questions: z.array(z.object({
  title: z.string().trim().min(1).max(1000),
  options: z.array(z.string().trim().min(1).max(500)).min(1).max(8).optional(),
}).strict()).min(1).max(5) }).strict();
const userInputTool = {
  name: 'request_user_input_async',
  title: '向用户提问',
  description: '向用户发送一组简短问题并立即返回。用户可选择建议答案或填写自由文本；回答随后作为新的用户消息进入本会话。此工具不等待回答。',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { questions: { type: 'array', minItems: 1, maxItems: 5, items: {
      type: 'object', additionalProperties: false,
      properties: { title: { type: 'string', minLength: 1, maxLength: 1000 }, options: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 500 } } },
      required: ['title'],
    } } }, required: ['questions'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/** Codex MCP `tools/call` `_meta` shape that carries call identity and turn metadata. */
const metaSchema = z.object({
  callId: z.string().min(1).optional(),
  'x-codex-turn-metadata': z.object({
    thread_id: z.string().optional(),
    session_id: z.string().optional(),
    turn_id: z.string().optional(),
    model: z.string().optional(),
  }).optional(),
}).optional();

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Resolve Web session/turn UUIDs from the App-Server-native thread id carried inside `_meta`. */
function resolveContext(meta: ReturnType<typeof metaSchema.parse>, manager?: SessionManager): ApprovalMcpContext | null {
  const turnMeta = meta?.['x-codex-turn-metadata'];
  if (!turnMeta?.thread_id || !manager) return null;
  return manager.findSessionByThreadId(turnMeta.thread_id);
}

/** Stateless transport with a synchronous approval waiter scoped to one session turn. */
export class ApprovalMcpService {
  constructor(private readonly token: string, private readonly requestApproval: RequestApproval,
    private readonly requestUserInput?: RequestUserInput) {
    if (Buffer.byteLength(token) < 32) throw new Error('Approval MCP token must be at least 32 bytes');
  }

  authenticate(token: string): boolean {
    const expected = Buffer.from(this.token);
    const supplied = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async handle(context: ApprovalMcpContext | null, message: unknown, signal: AbortSignal): Promise<{ status: number; body?: unknown }> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return { status: 200, body: rpcError(null, -32600, 'Invalid request') };
    const request = message as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof request.method !== 'string') return { status: 200, body: rpcError(request.id, -32600, 'Invalid request') };
    if (request.id === undefined) return { status: 202 };
    if (request.method === 'initialize') {
      const requested = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = typeof requested === 'string' && ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : '2025-06-18';
      return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {
        protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'swarm-approvals', version: '2.0.0' },
      } } };
    }
    if (request.method === 'ping') return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {} } };
    if (request.method === 'tools/list') return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: { tools: [tool, userInputTool] } } };
    if (request.method !== 'tools/call') return { status: 200, body: rpcError(request.id, -32601, 'Method not found') };
    const params = request.params as { name?: unknown; arguments?: unknown; _meta?: unknown } | undefined;
    if (params?.name !== tool.name && params?.name !== userInputTool.name) return { status: 200, body: rpcError(request.id, -32602, 'Unknown tool') };
    if (!context) return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {
      isError: true, content: [{ type: 'text', text: '审批 MCP 已连接，但尚未配置来源 Sandbox 到活动任务的定位。不得执行待审批操作。' }],
    } } };
    if (params.name === userInputTool.name) {
      const parsed = userInputSchema.safeParse(params.arguments);
      if (!parsed.success || !this.requestUserInput) return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {
        isError: true, content: [{ type: 'text', text: parsed.success ? '用户提问服务不可用' : `提问参数无效：${z.prettifyError(parsed.error)}` }],
      } } };
      const meta = metaSchema.parse(params._meta);
      try {
        const receipt = await this.requestUserInput(context, parsed.data.questions, meta?.callId ?? randomUUID());
        const result = { accepted: true, requestId: receipt.id };
        return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {
          content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
        } } };
      } catch (error) { return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {
        isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '提问发送失败' }],
      } } }; }
    }
    const parsed = approvalInputSchema.safeParse(params.arguments);
    if (!parsed.success) return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {
      isError: true, content: [{ type: 'text', text: `审批工单参数无效：${z.prettifyError(parsed.error)}` }],
    } } };
    const meta = metaSchema.parse(params._meta);
    const requestId = meta?.callId ?? randomUUID();
    let approval: UserApproval;
    try { approval = await this.requestApproval(context, parsed.data, requestId, signal); }
    catch (error) { return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {
      isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '审批工单提交失败' }],
    } } }; }
    const receipt = { ...approval, approved: approval.status === 'approved' };
    return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {
      content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt,
    } } };
  }
}

export function installApprovalMcpRoutes(app: Hono, service?: ApprovalMcpService, manager?: SessionManager) {
  if (!service) return;
  app.use('/mcp/approvals', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: '请求过大' }, 413) }));
  app.post('/mcp/approvals', async c => {
    const authorization = c.req.header('authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return c.json({ error: '未授权' }, 401);
    if (!service.authenticate(authorization.slice(7))) return c.json({ error: '无效的 MCP token' }, 401);
    const message = await c.req.json();
    // Resolve context from Codex `_meta` when the route handler itself has no session context.
    const context = resolveContextFromMessage(message, manager);
    const result = await service.handle(context, message, c.req.raw.signal);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return result.body === undefined ? c.body(null, result.status as 202) : c.json(result.body, result.status as 200);
  });
  app.all('/mcp/approvals', c => c.json({ error: '仅支持 MCP POST transport' }, 405));
}

/** Extract Codex `_meta` from a JSON-RPC message and build an `ApprovalMcpContext`. */
function resolveContextFromMessage(message: unknown, manager?: SessionManager): ApprovalMcpContext | null {
  if (!manager || !message || typeof message !== 'object') return null;
  const request = message as { params?: { _meta?: unknown } };
  if (!request.params?._meta || typeof request.params._meta !== 'object') return null;
  const meta = metaSchema.parse(request.params._meta);
  return resolveContext(meta, manager);
}
