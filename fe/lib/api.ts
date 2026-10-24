import type { ApiErrorResponse } from '../../protocol/types';
import { pageLoadRequest } from './page-load';

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string, public readonly upstreamStatus?: number) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const timing = pageLoadRequest(path);
  const started = performance.now();
  let response: Response | undefined;
  let error: 'network' | 'protocol' | 'http' | 'abort' | undefined;
  try {
    const headers = new Headers(init?.headers);
    if (!(init?.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (timing) headers.set('X-CoCell-Page-View', timing.pageViewId);
    response = await fetch(path, { ...init, headers });
    if (response.status === 204 || response.status === 205) return undefined as T;
    let body: unknown;
    try { body = await response.json(); }
    catch {
      if (response.ok) {
        error = 'protocol';
        const mutation = !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase());
        throw new ApiError(mutation ? '请求已提交，但响应无法确认；请查询状态后决定下一步。' : '服务返回了无法解析的数据。',
          502, mutation ? 'UNKNOWN_OUTCOME' : 'PROTOCOL', response.status);
      }
      body = {};
    }
    if (!response.ok) {
      error = 'http';
      const detail = body as Partial<ApiErrorResponse>;
      throw new ApiError(typeof detail.error === 'string' ? detail.error : detail.error?.message || `请求失败 (${response.status})`,
        response.status, detail.code || (typeof detail.error === 'object' ? detail.error?.code : undefined), detail.upstreamStatus);
    }
    return body as T;
  } catch (failure) {
    error ??= failure instanceof Error && failure.name === 'AbortError' ? 'abort' : 'network';
    throw failure;
  } finally {
    const traceId = response?.headers.get('X-Trace-Id') ?? '';
    timing?.record({ method: (init?.method ?? 'GET').toUpperCase(), path: path.split('?')[0], startMs: Math.round(started),
      durationMs: Math.round(performance.now() - started), status: response?.status,
      traceId: /^[a-f0-9]{32}$/i.test(traceId) ? traceId : undefined, error });
  }
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
