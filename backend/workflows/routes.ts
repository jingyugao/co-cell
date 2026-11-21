import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { WorkflowService } from './service.js';

const id = z.string().uuid();
const mutation = { expectedRevision: z.number().int().positive(), clientRequestId: id };
const reason = z.string().trim().max(6000);
export function installWorkflowRoutes(app: Hono, service?: WorkflowService) {
  const workflows = () => {
    if (!service) throw new HttpError(503, '工作台尚未初始化');
    return service;
  };
  const base = '/api/workflow-runs';
  app.use(base + '/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get(base, async (c) => c.json(await workflows().list(id.optional().parse(c.req.query('projectId')))));
  app.post(base, async (c) => {
    const input = z
      .strictObject({
        projectId: id,
        requirement: z.string().trim().min(1).max(12000),
        parallelism: z.number().int().min(1).max(4).default(2),
        clientRequestId: id,
      })
      .parse(await c.req.json());
    return c.json(await workflows().create(input), 202);
  });
  app.get(base + '/:id', async (c) => c.json(await workflows().get(id.parse(c.req.param('id')))));
  app.get(base + '/:id/events', async (c) => {
    const after = z.coerce.number().int().nonnegative().default(0).parse(c.req.query('after'));
    return c.json((await workflows().get(id.parse(c.req.param('id')))).events.filter((e) => e.sequence > after));
  });
  app.get(base + '/:id/artifacts/:artifactId', async (c) => {
    const artifact = (await workflows().get(id.parse(c.req.param('id')))).artifacts.find(
      (a) => a.id === c.req.param('artifactId')
    );
    if (!artifact) throw new HttpError(404, '工件不存在');
    return c.json(artifact);
  });
  app.post(base + '/:id/approvals/:approvalId/decisions', async (c) => {
    const { decision, ...body } = z
      .strictObject({
        ...mutation,
        planId: id,
        planHash: z.string().regex(/^[a-f0-9]{64}$/),
        approvalRevision: z.number().int().positive(),
        decision: z.enum(['approve', 'reject', 'request-changes']),
        reason: reason.default(''),
      })
      .parse(await c.req.json());
    return c.json(
      await workflows().act(id.parse(c.req.param('id')), {
        kind: decision,
        ...body,
        approvalId: id.parse(c.req.param('approvalId')),
      }),
      202
    );
  });
  app.post(base + '/:id/tasks/:jobId/retry', async (c) => {
    const body = z.strictObject(mutation).parse(await c.req.json());
    return c.json(
      await workflows().act(id.parse(c.req.param('id')), {
        kind: 'retry',
        jobId: id.parse(c.req.param('jobId')),
        ...body,
      }),
      202
    );
  });
  for (const kind of ['pause', 'resume', 'cancel', 'reconcile', 'revise'] as const)
    app.post(base + '/:id/' + (kind === 'revise' ? 'design/revise' : kind), async (c) => {
      const body = z.strictObject({ ...mutation, reason: reason.optional() }).parse(await c.req.json());
      return c.json(await workflows().act(id.parse(c.req.param('id')), { kind, ...body }), 202);
    });
}
