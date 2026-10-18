export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function redactCredentials(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"'&,;]+)/gi,
      '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** The provider's error classification remains visible through local wrappers. */
export function providerError(error: unknown): { code: string; message: string; status: number; upstreamStatus?: number } | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const value = current as { name?: string; code?: string; message?: string; status?: number; cause?: unknown };
    if (value.name === 'CellboxError' && value.code) {
      const message = redactCredentials(value.message ?? value.code);
      const status = value.status && value.status >= 400 && value.status <= 599 ? value.status
        : ['BUSY', 'CONFLICT', 'STALE_GENERATION'].includes(value.code) ? 409 : value.code === 'UNSUPPORTED_CAPABILITY' ? 422 : 502;
      return { code: value.code, message, status,
        ...(value.status && value.status < 400 ? { upstreamStatus: value.status } : {}) };
    }
    current = value.cause;
  }
  return undefined;
}
