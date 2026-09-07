export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body as T;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
