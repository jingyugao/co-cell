import type { ProjectResumeError, ProjectResumeProgress } from '../../protocol/resume-types.js';
import type { ProjectSummary } from '../../protocol/types.js';

export class ResumeRequestError extends Error {
  constructor(message: string, readonly outcome: 'failed' | 'unknown', readonly details?: ProjectResumeError) {
    super(message);
    this.name = 'ResumeRequestError';
  }
}

type ResumeEvent = { event: string; data: string };
const MAX_EVENT_BYTES = 64 * 1024;
const RESUME_STAGES = new Set(['received', 'preparing', 'submitting', 'accepted', 'running', 'ports_listening', 'syncing', 'completed']);
const encoder = new TextEncoder();

function outcomeFor(code: unknown, status: number): 'failed' | 'unknown' {
  if (code === 'UNKNOWN_OUTCOME' || code === 'TRANSPORT' || status >= 500 || status === 408 || status === 429) return 'unknown';
  return 'failed';
}

function parseError(response: Response, body: unknown): ResumeRequestError {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : undefined;
  const message = typeof record.message === 'string' ? record.message
    : typeof record.error === 'string' ? record.error
      : typeof nested?.message === 'string' ? nested.message : `恢复请求失败 (${response.status})`;
  const code = typeof record.code === 'string' ? record.code
    : typeof nested?.code === 'string' ? nested.code : undefined;
  return new ResumeRequestError(message, outcomeFor(code, response.status), {
    message, ...(code ? { code } : {}),
    status: response.status,
    at: new Date().toISOString(),
    elapsedMs: 0,
  });
}

/** Sends one resume request and consumes its request-local progress stream. */
export async function resumeProjectSandbox(projectId: string,
  onProgress: (progress: ProjectResumeProgress) => void): Promise<ProjectSummary> {
  let response: Response;
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sandbox/resume`, {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
    });
  } catch (error) {
    throw new ResumeRequestError(error instanceof Error ? error.message : '恢复请求连接中断', 'unknown');
  }

  if (!response.ok) {
    let body: unknown;
    try {
      const contentType = response.headers.get('content-type') ?? '';
      body = contentType.includes('json') ? await response.json() : await response.text();
    } catch { /* The HTTP status still confirms that the request was rejected. */ }
    throw parseError(response, body);
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) {
    throw new ResumeRequestError('服务未返回恢复进度流；请查询项目状态，本次不会自动重试。', 'unknown');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let data: string[] = [];
  let completed: ProjectSummary | undefined;
  let terminalError: ResumeRequestError | undefined;
  let lastSequence = 0;
  let lastElapsedMs = 0;

  const dispatch = (event: ResumeEvent) => {
    if (!event.data) return;
    let parsed: unknown;
    try { parsed = JSON.parse(event.data); }
    catch { throw new ResumeRequestError('恢复进度流包含无法解析的数据；请查询项目状态。', 'unknown'); }
    if (event.event === 'progress') {
      const progress = parsed as ProjectResumeProgress;
      if (!Number.isInteger(progress.sequence) || progress.sequence !== lastSequence + 1 || !RESUME_STAGES.has(progress.stage)
        || typeof progress.at !== 'string' || !Number.isFinite(Date.parse(progress.at))
        || typeof progress.elapsedMs !== 'number' || !Number.isFinite(progress.elapsedMs) || progress.elapsedMs < 0
        || progress.elapsedMs < lastElapsedMs
        || (progress.resumePath !== undefined && progress.resumePath !== 'warm_pool' && progress.resumePath !== 'standard')
        || (progress.waitPorts !== undefined && (!Array.isArray(progress.waitPorts)
          || progress.waitPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)))) {
        throw new ResumeRequestError('恢复进度数据格式无效；请查询项目状态。', 'unknown');
      }
      lastSequence = progress.sequence;
      lastElapsedMs = progress.elapsedMs;
      onProgress(progress);
    } else if (event.event === 'complete') {
      const project = parsed as ProjectSummary;
      if (project?.id !== projectId || project.sandboxOperation?.kind !== 'resume' || project.sandboxOperation.status !== 'succeeded') {
        throw new ResumeRequestError('恢复完成数据与请求不匹配；请查询项目状态。', 'unknown');
      }
      completed = project;
    } else if (event.event === 'error') {
      const details = parsed as ProjectResumeError;
      if (typeof details.message !== 'string' || !Number.isInteger(details.status) || details.status < 100 || details.status > 599
        || typeof details.at !== 'string' || !Number.isFinite(Date.parse(details.at))
        || !Number.isFinite(details.elapsedMs) || details.elapsedMs < 0
        || (details.outcome !== undefined && details.outcome !== 'failed' && details.outcome !== 'unknown')
        || (details.code !== undefined && typeof details.code !== 'string')) {
        throw new ResumeRequestError('恢复错误数据格式无效；请查询项目状态。', 'unknown');
      }
      const outcome = details.outcome ?? outcomeFor(details.code, details.status);
      terminalError = new ResumeRequestError(details.message || '恢复失败', outcome, details);
    }
  };

  const processLine = (rawLine: string) => {
    if (encoder.encode(rawLine).byteLength > MAX_EVENT_BYTES) {
      throw new ResumeRequestError('恢复进度数据过长；请查询项目状态。', 'unknown');
    }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      dispatch({ event: eventName, data: data.join('\n') });
      eventName = 'message';
      data = [];
    } else if (line.startsWith(':')) {
      // SSE comments are keepalive heartbeats.
    } else {
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'event') eventName = value;
      else if (field === 'data') {
        data.push(value);
        if (data.join('\n').length > MAX_EVENT_BYTES) throw new ResumeRequestError('恢复进度数据过长；请查询项目状态。', 'unknown');
      }
    }
  };

  try {
    while (!completed && !terminalError) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer) processLine(buffer);
        processLine('');
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (completed || terminalError) break;
      }
      if (buffer.length > MAX_EVENT_BYTES) throw new ResumeRequestError('恢复进度数据过长；请查询项目状态。', 'unknown');
    }
  } catch (error) {
    if (error instanceof ResumeRequestError) terminalError = error;
    else terminalError = new ResumeRequestError('恢复进度连接中断；请查询项目状态，本次不会自动重试。', 'unknown');
  } finally {
    if (completed || terminalError) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (terminalError) throw terminalError;
  if (!completed) throw new ResumeRequestError('恢复进度流已结束，但没有收到完成确认；请查询项目状态。', 'unknown');
  return completed;
}
