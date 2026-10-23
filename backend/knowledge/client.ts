import { createHash } from 'node:crypto';
import { redactCredentials } from '../../util/errors.js';

const REQUEST_TIMEOUT_MS = 30_000;

export interface RetainRequest {
  async: true;
  operation_id: string;
  items: Array<{
    content: string;
    document_id: string;
    timestamp: string;
    context: string;
    metadata: Record<string, string>;
    tags: string[];
    observation_scopes: 'shared';
    update_mode: 'replace';
  }>;
}

export interface HindsightOperation {
  status: string;
  error_message?: string;
  child_operations?: Array<{ status: string; error_message?: string }>;
}

export interface KnowledgeNode {
  id: string;
  kind: 'folder' | 'page';
  name: string;
  children?: KnowledgeNode[];
  mental_model_id?: string;
}

export interface HindsightModel {
  id: string;
  source_query: string;
  content: string | null;
  tags: string[];
  trigger: Record<string, unknown>;
  last_refreshed_at?: string | null;
  last_refresh_failed_at?: string | null;
  is_stale?: boolean;
  reflect_response?: { based_on?: Record<string, Array<{ id: string }>> };
}

export class HindsightError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HindsightError';
  }
}

function canonicalBase(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Hindsight URL must be a valid HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Hindsight URL must not contain credentials, a query, or a fragment');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

export class HindsightClient {
  readonly target: string;
  readonly bankId: string;
  private readonly baseUrl: URL;

  constructor(options: { url: string; bankId: string; apiKey?: string }) {
    const bankId = options.bankId.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(bankId)) throw new Error('Hindsight bank ID is invalid');
    this.baseUrl = canonicalBase(options.url);
    this.bankId = bankId;
    this.apiKey = options.apiKey;
    const canonicalTarget = `${this.baseUrl.origin}${this.baseUrl.pathname}\0${bankId}`;
    this.target = createHash('sha256').update(canonicalTarget).digest('hex');
  }

  private readonly apiKey?: string;

  async request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const relativePath = path.replace(/^\/+/, '');
    if (relativePath.startsWith('//') || relativePath.includes('#') || /^[a-z][a-z\d+.-]*:/i.test(relativePath)
      || relativePath.split(/[/?#]/).some(part => part === '.' || part === '..') || relativePath.includes('\\'))
      throw new Error('Hindsight API path must be relative to the configured bank');

    const prefix = this.baseUrl.pathname.replace(/\/+$/, '');
    const apiRoot = `${prefix}/v1/default/banks/${encodeURIComponent(this.bankId)}`;
    const url = new URL(relativePath ? `${apiRoot}/${relativePath}` : apiRoot, this.baseUrl.origin);
    const headers = new Headers({ accept: 'application/json' });
    if (this.apiKey) headers.set('authorization', `Bearer ${this.apiKey}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), options.signal])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      const message = redactCredentials(error instanceof Error ? error.message : 'Request failed');
      throw new HindsightError(0, this.apiKey ? message.split(this.apiKey).join('[REDACTED]') : message);
    }

    if (!response.ok) throw new HindsightError(response.status, `Hindsight returned HTTP ${response.status}`);
    if (response.status === 204) return undefined as T;
    try {
      return await response.json() as T;
    } catch {
      throw new HindsightError(502, 'Hindsight returned an invalid JSON response');
    }
  }
}
