import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 4096;
const LOG_NAME = /^runtime-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.1)?$/;
const OMITTED = '[OMITTED]';
const REDACTED = '[REDACTED]';
const bodyKeys = new Set(['prompt', 'messages', 'input', 'output', 'arguments', 'args', 'command', 'text', 'content', 'body', 'stdout', 'stderr', 'aggregatedoutput', 'reasoning', 'instructions', 'payload']);
const sensitiveKey = (key: string) => /secret|password|passwd|credential|authorization|cookie|apikey|accesstoken|refreshtoken|authtoken|idtoken/.test(key) || key === 'token' || key === 'bearer';

/** Bounded operational metadata only. Logging failure must never fail an agent turn. */
export class RuntimeLog {
  private readonly directory: string;
  private readonly secrets: string[];
  private pending: Promise<void> = Promise.resolve();
  private cleanedDay?: string;
  private warned = false;

  constructor(options: { directory?: string; secrets?: string[] } = {}) {
    this.directory = resolve(options.directory ?? 'data/logs');
    this.secrets = [...new Set(options.secrets?.filter(Boolean) ?? [])].sort((a, b) => b.length - a.length);
  }

  private warn() {
    if (this.warned) return;
    this.warned = true;
    try { console.error('Runtime log write failed; agent execution will continue.'); } catch { /* Diagnostics cannot affect execution either. */ }
  }

  private text(value: string): string {
    let result = value;
    for (const secret of this.secrets) result = result.replaceAll(secret, REDACTED);
    result = result
      .replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`)
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)\s*[=:]\s*["']?)[^\s"'&,;]+/gi, `$1${REDACTED}`)
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
    return result.length > MAX_TEXT ? result.slice(0, MAX_TEXT) + '[TRUNCATED]' : result;
  }

  private sanitize(record: Record<string, unknown>): Record<string, unknown> {
    let nodes = 0;
    const seen = new WeakSet<object>();
    const visit = (value: unknown, depth: number): unknown => {
      if (++nodes > 300 || depth > 5) return '[TRUNCATED]';
      if (typeof value === 'string') return this.text(value);
      if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
      if (typeof value === 'boolean' || value === null) return value;
      if (value === undefined) return undefined;
      if (typeof value === 'bigint') return String(value);
      if (typeof value !== 'object') return '[UNSUPPORTED]';
      if (seen.has(value)) return '[CIRCULAR]';
      seen.add(value);
      if (value instanceof Error) return { name: this.text(value.name), message: this.text(value.message) };
      if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : '[INVALID DATE]';
      if (Array.isArray(value)) return value.slice(0, 20).map(item => visit(item, depth + 1));
      const output: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value).slice(0, 50)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        const safeKey = this.text(key).slice(0, 128);
        output[safeKey] = sensitiveKey(normalized) ? REDACTED : bodyKeys.has(normalized) ? OMITTED : visit(item, depth + 1);
      }
      return output;
    };
    return visit(record, 0) as Record<string, unknown>;
  }

  write(record: Record<string, unknown>): Promise<void> {
    let line: string, day: string;
    try {
      const timestamp = new Date().toISOString();
      day = timestamp.slice(0, 10);
      line = JSON.stringify({ ...this.sanitize(record), timestamp }).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029') + '\n';
    } catch { this.warn(); return Promise.resolve(); }
    this.pending = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(this.directory)).isDirectory()) throw new Error('Invalid log directory');
      await chmod(this.directory, 0o700);
      if (this.cleanedDay !== day) {
        const cutoff = Date.parse(day) - 7 * 24 * 60 * 60 * 1000;
        for (const name of await readdir(this.directory)) {
          const match = LOG_NAME.exec(name);
          if (match && Date.parse(match[1]) <= cutoff) await rm(join(this.directory, name), { force: true });
        }
        this.cleanedDay = day;
      }
      const path = join(this.directory, `runtime-${day}.jsonl`);
      const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
      let file = await open(path, flags, 0o600);
      try {
        await file.chmod(0o600);
        if ((await file.stat()).size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
          await file.close();
          await rm(`${path}.1`, { force: true });
          await rename(path, `${path}.1`);
          file = await open(path, flags, 0o600);
        }
        await file.appendFile(line, 'utf8');
      } finally { await file.close(); }
    }).catch(() => { this.warn(); });
    return this.pending;
  }

  async flush(): Promise<void> { await this.pending; }
}
