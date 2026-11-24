import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Project } from '../../protocol/types.js';
import { redactCredentials } from '../../util/errors.js';
import { HindsightClient, HindsightError } from './client.js';

const sessionId = z.string().uuid();
const submission = z.object({
  async: z.literal(true), operation_id: z.string().uuid(),
  items: z.tuple([z.object({
    content: z.string().min(1), context: z.string().max(8192), timestamp: z.string().datetime({ offset: true }),
    document_id: z.string(), update_mode: z.enum(['append', 'replace']).optional(),
    metadata: z.object({ session_id: sessionId, harness: z.enum(['codex', 'claude-code']) }),
  })]),
});

type ProjectInfo = Pick<Project, 'id' | 'name' | 'status' | 'removedAt'>;
const eligible = (project: ProjectInfo) => !project.removedAt && project.name.trim().toLowerCase() !== 'system'
  && ['active', 'completed'].includes(project.status ?? 'active');

// The hook and Hindsight both use UUIDs. Namespace the hook's idempotency key by project
// on submission and status lookup so that another project's operation cannot be replayed.
function operationId(project: string, id: string) {
  const bytes = createHash('sha256').update(JSON.stringify([project, id])).digest();
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex', 0, 16);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** A stateless, write-only adapter for the official Stop hooks. The upstream API key stays on the server. */
export class HookRetain {
  constructor(private client: HindsightClient, private secret: string, private origin: string,
    private getProject: (id: string) => Promise<ProjectInfo | undefined>,
    private sessionIdForThread: (projectId: string, threadId: string) => Promise<string | undefined>) {}

  private token(projectId: string) {
    return createHmac('sha256', this.secret).update(JSON.stringify(['hindsight-retain', this.client.bankId, this.client.origin, projectId])).digest('hex');
  }

  config(projectId: string) {
    return { disabled: false, apiUrl: this.origin + '/internal/hindsight/' + encodeURIComponent(projectId), bankId: this.client.bankId,
      apiToken: this.token(projectId), dynamicBankId: false, retainSessions: true, manageBankConfig: false };
  }

  routes() {
    const app = new Hono<{ Variables: { project: ProjectInfo } }>();
    app.use('/:project/*', async (c, next) => {
      const projectId = c.req.param('project');
      const token = /^Bearer ([a-f0-9]{64})$/.exec(c.req.header('authorization') ?? '')?.[1];
      if (!projectId || !token
        || !timingSafeEqual(Buffer.from(token), Buffer.from(this.token(projectId)))) return c.body(null, 401);
      const project = await this.getProject(projectId);
      if (!project || !eligible(project)) return c.body(null, 403);
      c.set('project', project);
      c.header('Cache-Control', 'no-store');
      await next();
    });
    app.onError((error, c) => {
      if (error instanceof HindsightError) {
        // The official client treats a 404 as a successful POST. Surface an upstream
        // write to a missing endpoint/bank as a delivery failure so it can be retried.
        const status = c.req.method === 'POST' && error.status === 404 ? 502 : error.status || 502;
        return c.body(null, status as 502);
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) return c.body(null, 400);
      return c.body(null, 503);
    });
    app.get('/:project/v1/version', async c => c.json({ api_version: (await this.client.version()).api_version }));
    const bank = '/:project/v1/default/banks/:bank';
    app.use(bank + '/*', async (c, next) => {
      if (c.req.param('bank') !== this.client.bankId) return c.body(null, 403);
      await next();
    });
    app.get(bank + '/config', async c => {
      const value = await this.client.request<{ config?: { store_document_text?: boolean } }>('config');
      return c.json({ config: { store_document_text: value.config?.store_document_text } });
    });
    app.get(bank + '/operations/:id', async c => {
      const id = operationId(c.get('project').id, sessionId.parse(c.req.param('id')));
      const operation = await this.client.request<{ status: string }>('operations/' + id);
      return c.json({ status: operation.status });
    });
    app.post(bank + '/memories', bodyLimit({ maxSize: 64 * 1024 * 1024, onError: c => c.body(null, 413) }), async c => {
      const { operation_id, items: [item] } = submission.parse(await c.req.json());
      const project = c.get('project');
      const { session_id, harness } = item.metadata;
      if (item.document_id !== 'conversation:' + session_id) return c.body(null, 400);
      const document = `cocell/${project.id}/${item.document_id}`;
      const cocellSession = await this.sessionIdForThread(project.id, session_id);
      const token = this.token(project.id);
      const scrub = (text: string) => redactCredentials(text.replaceAll(token, '[REDACTED]'));
      const content = item.content.split('\n').map(line => {
        const turn = JSON.parse(line);
        if (turn?.role === 'system' && turn.content === 'REF-ID: ' + item.document_id) turn.content = 'REF-ID: ' + document;
        return JSON.stringify(turn, (key, value) => {
          if (/^(?:api[_-]?(?:key|token)|access[_-]?token|authorization|password|passwd|secret|token)$/i.test(key)) return '[REDACTED]';
          return typeof value === 'string' ? scrub(value) : value;
        });
      }).join('\n');
      await this.client.request('memories', { method: 'POST', body: {
        async: true, operation_id: operationId(project.id, operation_id), items: [{
          ...item, document_id: document, content, context: scrub(item.context), strategy: 'conversation',
          observation_scopes: 'shared', tags: ['source:cocell', 'source:chat', 'harness:' + harness, 'project:' + project.id],
          metadata: { ...item.metadata, project_id: project.id, project_name: project.name, ref_id: document,
            ...(cocellSession ? { cocell_session_id: cocellSession } : {}) },
        }],
      } });
      return c.json({ operation_id }, 202);
    });
    return app;
  }
}
