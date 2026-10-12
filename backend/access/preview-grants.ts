import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface PreviewGrant {
  host: string;
  path: string;
  challenge: string;
  expires: number;
}

export interface PreviewGrantStore {
  issue(grant: PreviewGrant): Promise<string>;
  consume(code: string, host: string, challenge: string): Promise<PreviewGrant | undefined>;
}

const MAX_MEMORY_GRANTS = 10_000;
const MEMORY_CLEANUP_LIMIT = 256;
const MYSQL_CLEANUP_LIMIT = 100;

function digest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function createCode(): string {
  return randomBytes(32).toString('base64url');
}

function isValidGrant(grant: PreviewGrant): boolean {
  return Boolean(grant.host && grant.path.startsWith('/') && !grant.path.startsWith('//') && grant.challenge &&
    Number.isSafeInteger(grant.expires) && grant.expires > Date.now());
}

export class MemoryPreviewGrantStore implements PreviewGrantStore {
  private readonly grants = new Map<string, PreviewGrant>();

  async issue(grant: PreviewGrant): Promise<string> {
    if (!isValidGrant(grant)) throw new TypeError('Invalid or expired preview grant');
    this.removeExpired(MEMORY_CLEANUP_LIMIT);
    if (this.grants.size >= MAX_MEMORY_GRANTS) {
      throw new Error('Preview grant store capacity reached');
    }
    const code = createCode();
    this.grants.set(digest(code), { ...grant });
    return code;
  }

  async consume(code: string, host: string, challenge: string): Promise<PreviewGrant | undefined> {
    if (!code || !host || !challenge) return undefined;
    const key = digest(code);
    const grant = this.grants.get(key);
    if (!grant || grant.host !== host || grant.challenge !== challenge) return undefined;
    this.grants.delete(key);
    if (grant.expires <= Date.now()) return undefined;
    return { ...grant };
  }

  private removeExpired(limit: number) {
    const now = Date.now();
    let removed = 0;
    for (const [key, grant] of this.grants) {
      if (grant.expires <= now) {
        this.grants.delete(key);
        if (++removed >= limit) break;
      }
    }
  }
}

interface PreviewGrantRow extends RowDataPacket {
  host: string;
  path: string;
  challenge: string;
  expires: number | string;
}

export class MySqlPreviewGrantStore implements PreviewGrantStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS preview_grants (
      code_hash CHAR(64) NOT NULL PRIMARY KEY,
      host VARCHAR(255) NOT NULL,
      grant_path TEXT NOT NULL,
      challenge VARCHAR(255) NOT NULL,
      expires BIGINT UNSIGNED NOT NULL,
      INDEX preview_grants_expires (expires)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }

  async issue(grant: PreviewGrant): Promise<string> {
    if (!isValidGrant(grant)) throw new TypeError('Invalid or expired preview grant');
    await this.pool.query(
      'DELETE FROM preview_grants WHERE expires <= ? ORDER BY expires LIMIT ?',
      [Date.now(), MYSQL_CLEANUP_LIMIT],
    );
    const code = createCode();
    await this.pool.query(
      'INSERT INTO preview_grants (code_hash, host, grant_path, challenge, expires) VALUES (?, ?, ?, ?, ?)',
      [digest(code), grant.host, grant.path, grant.challenge, grant.expires],
    );
    return code;
  }

  async consume(code: string, host: string, challenge: string): Promise<PreviewGrant | undefined> {
    if (!code || !host || !challenge) return undefined;
    const codeHash = digest(code);
    const now = Date.now();
    const [rows] = await this.pool.query<PreviewGrantRow[]>(
      'SELECT host, grant_path AS path, challenge, expires FROM preview_grants WHERE code_hash = ? AND host = ? AND challenge = ? AND expires > ? LIMIT 1',
      [codeHash, host, challenge, now],
    );
    const row = rows[0];
    if (!row) return undefined;
    const [deleted] = await this.pool.query<ResultSetHeader>(
      'DELETE FROM preview_grants WHERE code_hash = ? AND host = ? AND challenge = ? AND expires > ?',
      [codeHash, host, challenge, Date.now()],
    );
    if (deleted.affectedRows !== 1) return undefined;
    return {
      host: row.host,
      path: row.path,
      challenge: row.challenge,
      expires: Number(row.expires),
    };
  }
}
