import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ProjectSummary } from '../../protocol/types.js';
import type { ProjectResumeError, ProjectResumeObserver, ProjectResumeProgress } from '../../protocol/resume-types.js';
import { HttpError, providerError, redactCredentials } from '../../util/errors.js';

/** One submission with transient progress; disconnecting only stops observation. */
export function resumeStream(c: Context, resume: (observe: ProjectResumeObserver) => Promise<ProjectSummary>): Response {
  c.req.raw.signal.throwIfAborted();
  c.header('X-Accel-Buffering', 'no');
  const response = streamSSE(c, async stream => {
    const started = performance.now();
    let sequence = 0;
    let closed = false;
    let queue = Promise.resolve();
    const timing = () => ({ at: new Date().toISOString(), elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
    const send = (event: 'progress' | 'complete' | 'error', data: unknown) => {
      if (closed) return;
      queue = queue.then(async () => {
        if (!closed) await stream.writeSSE({ event, data: JSON.stringify(data) });
      }).catch(() => { closed = true; });
    };
    let latest: Parameters<ProjectResumeObserver>[0] = { stage: 'received' };
    const observe: ProjectResumeObserver = update => {
      latest = { ...latest, ...update };
      const progress: ProjectResumeProgress = { ...latest, sequence: ++sequence, ...timing() };
      send('progress', progress);
    };
    stream.onAbort(() => { closed = true; });
    const heartbeat = setInterval(() => {
      if (!closed) queue = queue.then(async () => {
        if (!closed) await stream.write(': heartbeat\n\n');
      }).catch(() => { closed = true; });
    }, 15_000);
    try {
      observe({ stage: 'received' });
      const project = await resume(observe);
      send('complete', project);
    } catch (error) {
      const provider = providerError(error);
      const failure: ProjectResumeError = { ...timing(),
        message: provider?.message ?? redactCredentials(error instanceof Error ? error.message : String(error)),
        status: provider?.status ?? (error instanceof HttpError ? error.status : 500),
        ...(provider ? { code: provider.code,
          outcome: ['UNKNOWN_OUTCOME', 'TRANSPORT'].includes(provider.code) ? 'unknown' : 'failed' } : {}) };
      send('error', failure);
    } finally {
      clearInterval(heartbeat);
      await queue;
    }
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
