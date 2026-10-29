import type { Hono } from 'hono';
import { z } from 'zod';
import { reportPeriod } from '../../util/report-periods.js';
import { HttpError } from '../../util/errors.js';
import type { ReportKind, ReportSettings } from '../../protocol/report-types.js';
import type { ReportService } from './service.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  try { reportPeriod('daily', value); return true; } catch { return false; }
}, '日期必须是有效的 YYYY-MM-DD 日期');
const settings = z.object({
  revision: z.number().int().min(0),
  timezone: z.literal('Asia/Shanghai'),
  model: z.string().trim().min(1).max(200),
  modelEntryId: z.string().trim().min(1).max(100).optional(),
  daily: z.object({ enabled: z.boolean(), time }).strict(),
  weekly: z.object({ enabled: z.boolean(), weekday: z.number().int().min(1).max(7), time }).strict(),
  prompts: z.object({ daily: z.string().trim().min(1).max(20_000), weekly: z.string().trim().min(1).max(20_000) }).strict(),
}).strict();
const id = z.string().uuid();

export function installReportRoutes(app: Hono, service?: ReportService) {
  const reports = () => {
    if (!service) throw new HttpError(503, '工作报告模块尚未初始化');
    return service;
  };

  app.get('/api/reports', async c => {
    const query = z.object({
      offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).strict().parse(c.req.query());
    return c.json(await reports().view(query.offset, query.limit));
  });

  app.put('/api/reports/settings', async c => {
    const input: ReportSettings = settings.parse(await c.req.json());
    return c.json(await reports().update(input));
  });

  app.post('/api/reports', async c => {
    const input = z.object({ kind: z.enum(['daily', 'weekly']), date }).strict().parse(await c.req.json());
    return c.json(await reports().generate(input.kind as ReportKind, input.date), 202);
  });

  app.get('/api/reports/:id/sources/:sessionId', async c => c.json(await reports().source(
    id.parse(c.req.param('id')), id.parse(c.req.param('sessionId')),
    z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(c.req.query('offset') ?? 0))));

  app.get('/api/reports/:id', async c => c.json(await reports().detail(id.parse(c.req.param('id')))));

  app.post('/api/reports/:id/retry', async c => {
    const input = z.object({ updatedAt: z.string().datetime(), regenerate: z.boolean().optional() }).strict().parse(await c.req.json());
    await reports().retry(id.parse(c.req.param('id')), input.updatedAt, input.regenerate);
    return c.json({ ok: true as const }, 202);
  });
}
