import type { ApiErrorResponse } from '../../protocol/types';

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string, public readonly upstreamStatus?: number) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init?.headers } });
  if (response.status === 204 || response.status === 205) return undefined as T;
  let body: unknown;
  try { body = await response.json(); }
  catch {
    if (response.ok) {
      const mutation = !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase());
      throw new ApiError(mutation ? '请求已提交，但响应无法确认；请查询状态后决定下一步。' : '服务返回了无法解析的数据。',
        502, mutation ? 'UNKNOWN_OUTCOME' : 'PROTOCOL', response.status);
    }
    body = {};
  }
  if (!response.ok) {
    const error = body as Partial<ApiErrorResponse>;
    throw new ApiError(typeof error.error === 'string' ? error.error : error.error?.message || `请求失败 (${response.status})`,
      response.status, error.code || (typeof error.error === 'object' ? error.error?.code : undefined), error.upstreamStatus);
  }
  return body as T;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
