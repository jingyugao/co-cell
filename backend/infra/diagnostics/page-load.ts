import { z } from 'zod';
import { isPageLoadResourceUrl, type PageLoadReport } from '../../../protocol/page-load-types.js';
import type { RuntimeLog } from './runtime-log.js';

const milliseconds = z.number().finite().nonnegative();
const byteCount = z.number().finite().nonnegative();
const boundedText = (max: number) => z.string().min(1).max(max);
const pathname = z.string().min(1).max(256).refine(value => /^\/$|^\/(?:sessions|projects)\/[A-Za-z0-9_-]{1,100}\/?$/.test(value), 'Expected the root, session, or project pathname');
const apiPath = z.string().min(1).max(256).refine(value => value.startsWith('/') && !value.startsWith('//') && !value.includes('?') && !value.includes('#'), 'Expected an API pathname without query or fragment');
const safeResourceUrl = z.string().min(1).max(300).refine(isPageLoadResourceUrl, 'Expected an allowed static resource origin and pathname without query or fragment');

const milestonesSchema = z.object({
  telemetryStartedMs: milliseconds.optional(),
  bootstrapStartedMs: milliseconds.optional(),
  bootstrapReadyMs: milliseconds.optional(),
  shellPaintMs: milliseconds.optional(),
  websocketStartedMs: milliseconds.optional(),
  websocketConnectedMs: milliseconds.optional(),
  historyReadyMs: milliseconds.optional(),
  historyPaintMs: milliseconds.optional(),
  sessionReadyMs: milliseconds.optional(),
}).strict();

const navigationSchema = z.object({
  type: boundedText(32), dnsMs: milliseconds, connectMs: milliseconds, tlsMs: milliseconds,
  requestStartMs: milliseconds, responseStartMs: milliseconds, responseEndMs: milliseconds,
  domInteractiveMs: milliseconds, domContentLoadedMs: milliseconds, loadMs: milliseconds,
  transferBytes: byteCount, encodedBytes: byteCount, decodedBytes: byteCount,
}).strict();

const apiRequestSchema = z.object({
  method: boundedText(8), path: apiPath, startMs: milliseconds, durationMs: milliseconds,
  status: z.number().int().min(100).max(599).optional(),
  traceId: z.string().regex(/^[\da-f]{32}$/i).optional(),
  error: z.enum(['network', 'protocol', 'http', 'abort']).optional(),
}).strict();

const resourceSchema = z.object({
  url: safeResourceUrl, type: boundedText(32), startMs: milliseconds, durationMs: milliseconds,
  transferBytes: byteCount, encodedBytes: byteCount, decodedBytes: byteCount,
}).strict();

/** Strict, bounded schema: report payloads contain timing metadata only, never arbitrary objects. */
export const pageLoadReportSchema = z.object({
  pageViewId: z.string().uuid(), version: z.literal(1),
  reason: z.enum(['started', 'progress', 'ready', 'hidden', 'pagehide', 'timeout']),
  path: pathname,
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  timeOrigin: z.number().finite().nonnegative(), elapsedMs: milliseconds,
  visibility: z.enum(['visible', 'hidden']),
  viewport: z.object({ width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(), devicePixelRatio: z.number().finite().positive() }).strict(),
  milestones: milestonesSchema,
  navigation: navigationSchema.optional(),
  paint: z.object({ fcpMs: milliseconds.optional(), lcpMs: milliseconds.optional() }).strict().optional(),
  longTasks: z.object({ count: z.number().int().nonnegative(), totalMs: milliseconds, maxMs: milliseconds }).strict().optional(),
  apiRequests: z.array(apiRequestSchema).max(10),
  resources: z.array(resourceSchema).max(10),
  failures: z.array(z.object({ stage: boundedText(64), kind: boundedText(64), atMs: milliseconds }).strict()).max(10),
}).strict();

export type PageLoadLogWriter = Pick<RuntimeLog, 'write'>;

/** Append one validated report without delaying the browser's beacon response on disk I/O. */
export function recordPageLoad(writer: PageLoadLogWriter | undefined, report: PageLoadReport, userAgent?: string) {
  if (!writer) return;
  try {
    const pending = writer.write({
      event: 'client.page_load',
      ...report,
      ...(userAgent ? { userAgent: userAgent.slice(0, 256) } : {}),
    });
    void pending.catch(() => undefined);
  } catch { /* Diagnostics must not change page-load behavior. */ }
}
