export class GvisorHelperClient {
  constructor(private readonly baseUrl: string) {}
  async request<T>(input: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]);
    let response: Response;
    try {
      response = await fetch(new URL('/v1/actions', this.baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal });
    } catch (error) {
      if (signal.aborted) throw new Error('gVisor helper timeout');
      throw error;
    }
    const payload = await response.json() as { ok: boolean; result?: T; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'gVisor helper failed');
    return payload.result as T;
  }
}
