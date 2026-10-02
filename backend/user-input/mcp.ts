import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { UserInputQuestion } from '../../protocol/user-input-types.js';
import type { SessionManager } from '../sessions/manager.js';

const questionSchema = z.object({ title: z.string().trim().min(1).max(1000), options: z.array(z.string().trim().min(1).max(500)).min(1).max(8).optional() }).strict();
const inputSchema = z.object({ questions: z.array(questionSchema).min(1).max(5) }).strict();
const metaSchema = z.object({ callId: z.string().min(1).optional(), 'x-codex-turn-metadata': z.object({ thread_id: z.string().optional() }).optional() }).optional();
export class UserInputMcpService {
  constructor(private readonly token: string, private readonly manager: SessionManager) {}
  authenticate(value: string) { const a=Buffer.from(value), b=Buffer.from(this.token); return a.length===b.length && timingSafeEqual(a,b); }
  async handle(message: any) {
    if (message?.method === 'initialize') return { jsonrpc:'2.0', id:message.id, result:{ protocolVersion:'2025-06-18', capabilities:{tools:{listChanged:false}}, serverInfo:{name:'cocell-user-input',version:'1.0.0'} } };
    if (message?.method === 'ping') return { jsonrpc:'2.0', id:message.id, result:{} };
    if (message?.method === 'tools/list') return { jsonrpc:'2.0', id:message.id, result:{tools:[{name:'request_user_input_async',title:'向用户提问',description:'向用户发送一组简短问题；用户回答会作为新的用户消息进入本会话。',inputSchema:{type:'object',additionalProperties:false,properties:{questions:{type:'array',minItems:1,maxItems:5,items:{type:'object',additionalProperties:false,properties:{title:{type:'string',minLength:1,maxLength:1000},options:{type:'array',minItems:1,maxItems:8,items:{type:'string',minLength:1,maxLength:500}}},required:['title']}}},required:['questions']}}]} };
    if (message?.method !== 'tools/call' || message?.params?.name !== 'request_user_input_async') return { jsonrpc:'2.0', id:message?.id ?? null, error:{code:-32601,message:'Method not found'} };
    const parsed=inputSchema.safeParse(message.params.arguments); if(!parsed.success) return {jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:'提问参数无效'}]}};
    const meta=metaSchema.parse(message.params._meta); const threadId=meta?.['x-codex-turn-metadata']?.thread_id; const context=threadId ? this.manager.findSessionByThreadId(threadId) : null;
    if(!context) return {jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:'无法定位提问来源会话'}]}};
    const requestId=meta?.callId ?? randomUUID(); const receipt=await this.manager.requestUserInput(context.sessionId,context.turnId,context.projectId,requestId,parsed.data.questions as UserInputQuestion[]);
    return {jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify({accepted:true,requestId:receipt.id})}],structuredContent:{accepted:true,requestId:receipt.id}}};
  }
}
export function installUserInputMcpRoutes(app: Hono, service: UserInputMcpService) {
  app.use('/mcp/user-input', bodyLimit({maxSize:64*1024,onError:c=>c.json({error:'请求过大'},413)}));
  app.post('/mcp/user-input', async c=>{const auth=c.req.header('authorization')??'';if(!auth.startsWith('Bearer ')||!service.authenticate(auth.slice(7)))return c.json({error:'未授权'},401);return c.json(await service.handle(await c.req.json()));});
  app.all('/mcp/user-input',c=>c.json({error:'仅支持 MCP POST transport'},405));
}
