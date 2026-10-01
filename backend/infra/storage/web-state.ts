import type { ImageCatalogStore, ImageRecord } from '../../images/store.js';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import type { Project, Session, Turn } from '../../../protocol/types.js';
import type { SandboxState } from '../../../protocol/sandbox-types.js';

export interface WebStateStore {
  init(): Promise<void>; listProjects(): Promise<Project[]>; listSessions(): Promise<Session[]>;
  saveProject(project: Project): Promise<void>; saveSession(session: Session): Promise<void>;
  deleteProject(id: string): Promise<void>; deleteSession(id: string): Promise<void>; close(): Promise<void>;
}

type PersistedSandbox = Omit<SandboxState, 'status'>;
type SandboxWithTransientError = SandboxState & { statusError?: unknown };

function persistedSandbox(sandbox: SandboxState): PersistedSandbox {
  const { status: _status, statusError: _statusError, ...metadata } = sandbox as SandboxWithTransientError;
  return metadata;
}

function hydrateSandbox(value: SandboxState | undefined): SandboxState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { status: _oldStatus, statusError: _statusError, ...metadata } = value as SandboxWithTransientError;
  // The provider is the source of truth for status. Stored status values predate
  // this rule and are deliberately ignored on every load.
  return { ...metadata, status: 'unknown' } as SandboxState;
}

function persistedProject(project: Project) {
  const { sandbox, pendingSandboxCleanup, ...metadata } = project;
  return {
    ...metadata,
    ...(sandbox ? { sandbox: persistedSandbox(sandbox) } : {}),
    ...(pendingSandboxCleanup ? { pendingSandboxCleanup: pendingSandboxCleanup.map(persistedSandbox) } : {}),
  };
}

function hydrateProject(project: Project): Project {
  return {
    ...project,
    ...(project.sandbox ? { sandbox: hydrateSandbox(project.sandbox) } : {}),
    ...(project.pendingSandboxCleanup ? { pendingSandboxCleanup: project.pendingSandboxCleanup.map(sandbox => hydrateSandbox(sandbox)!) } : {}),
  };
}

function persistedSession(session: Session) {
  const { sandbox, ...metadata } = session;
  return { ...metadata, ...(sandbox ? { sandbox: persistedSandbox(sandbox) } : {}) };
}

function hydrateSession<T extends Session>(session: T): T {
  return { ...session, ...(session.sandbox ? { sandbox: hydrateSandbox(session.sandbox) } : {}) } as T;
}

function requireMySqlUrl(value: string | undefined): string {
  const url = value?.trim();
  if (!url) throw new Error('MYSQL_URL is required; CoCell stores project and session metadata only in MySQL.');
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'mysql:' && parsed.hostname && parsed.pathname.length > 1) return url;
  } catch { /* Report configuration errors without exposing credentials. */ }
  throw new Error('MYSQL_URL must be a valid mysql:// URL with a host and database name.');
}

/** Web metadata and sandbox-local ~/.codex are intentionally separate. */
export class MySqlWebStateStore implements WebStateStore, ImageCatalogStore {
  private pool: Pool;
  constructor(url: string) { this.pool = createPool({ uri: requireMySqlUrl(url), connectionLimit: 10, charset: 'utf8mb4', timezone: 'Z' }); }
  async listImages(): Promise<ImageRecord[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { document: ImageRecord | string }>>('SELECT document FROM managed_images');
    return rows.map(row => this.document<ImageRecord>(row.document));
  }
  async saveImage(image: ImageRecord) {
    await this.pool.query('INSERT INTO managed_images (id,document) VALUES (?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE document=VALUES(document)', [image.id, JSON.stringify(image)]);
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS managed_images (id CHAR(36) PRIMARY KEY, document JSON NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS projects (id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, requirement_url TEXT NULL, execution_mode ENUM('sandbox','local') NOT NULL, working_directory TEXT NOT NULL, archived_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, document JSON NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS sessions (id CHAR(36) PRIMARY KEY, project_id CHAR(36) NULL, thread_id VARCHAR(191) NULL, title VARCHAR(255) NOT NULL, status ENUM('idle','running','completed','failed','cancelled') NOT NULL, archived_at DATETIME(3) NULL, started_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, document JSON NOT NULL, INDEX sessions_project_updated (project_id, updated_at), CONSTRAINT sessions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }
  async listProjects(): Promise<Project[]> { const [rows] = await this.pool.query<Array<RowDataPacket & { document: Project | string }>>('SELECT document FROM projects'); return rows.map(row => hydrateProject(this.document<Project>(row.document))); }
  async listSessions(): Promise<Session[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { document: Session | string }>>('SELECT document FROM sessions');
    const sessions: Session[] = [];
    for (const row of rows) {
      const stored = hydrateSession(this.document<Session & { pendingTurns?: Turn[] }>(row.document));
      if (stored.settings.executionMode !== 'sandbox') { sessions.push(stored); continue; }
      const oldTurns = stored.turns ?? [];
      const pendingTurns = stored.pendingTurns ?? oldTurns.filter(turn => turn.codexAccepted && turn.status === 'running');
      const acceptedCount = oldTurns.filter(turn => turn.codexAccepted || turn.nativeTurnId).length;
      const session: Session = { ...stored, turns: pendingTurns,
        turnCount: Math.max(stored.turnCount ?? 0, acceptedCount) };
      delete (session as Session & { pendingTurns?: Turn[] }).pendingTurns;
      // Existing rows are compacted on startup; new documents never include `turns`.
      if ('turns' in stored) await this.saveSessionWith(this.pool, session);
      // A submission that never reached Codex has no App Server history.
      if (!session.threadId && !session.turnCount && session.status !== 'idle' && !pendingTurns.length) continue;
      sessions.push(session);
    }
    return sessions;
  }
  saveProject(project: Project): Promise<void> { return this.saveProjectWith(this.pool, project); }
  saveSession(session: Session): Promise<void> { return this.saveSessionWith(this.pool, session); }
  async deleteProject(id: string) { await this.pool.query('DELETE FROM projects WHERE id = ?', [id]); }
  async deleteSession(id: string) { await this.pool.query('DELETE FROM sessions WHERE id = ?', [id]); }
  async close() { await this.pool.end(); }
  private document<T>(value: T | string): T { return typeof value === 'string' ? JSON.parse(value) as T : value; }
  private async saveProjectWith(executor: Pick<Pool, 'query'>, project: Project) {
    await executor.query(`INSERT INTO projects (id,name,requirement_url,execution_mode,working_directory,archived_at,created_at,updated_at,document) VALUES (?,?,?,?,?,?,?,?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE name=VALUES(name),requirement_url=VALUES(requirement_url),execution_mode=VALUES(execution_mode),working_directory=VALUES(working_directory),archived_at=VALUES(archived_at),updated_at=VALUES(updated_at),document=VALUES(document)`, [project.id, project.name, project.requirementUrl, project.executionMode, project.workingDirectory, this.mysqlDate(project.archivedAt), this.mysqlDate(project.createdAt), this.mysqlDate(project.updatedAt), JSON.stringify(persistedProject(project))]);
  }
  private async saveSessionWith(executor: Pick<Pool, 'query'>, session: Session) {
    const document = session.settings.executionMode === 'sandbox' ? this.compactSandboxSession(session) : persistedSession(session);
    await executor.query(`INSERT INTO sessions (id,project_id,thread_id,title,status,archived_at,started_at,created_at,updated_at,document) VALUES (?,?,?,?,?,?,?,?,?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE project_id=VALUES(project_id),thread_id=VALUES(thread_id),title=VALUES(title),status=VALUES(status),archived_at=VALUES(archived_at),started_at=VALUES(started_at),updated_at=VALUES(updated_at),document=VALUES(document)`, [session.id, session.projectId ?? null, session.threadId, session.title, session.status, this.mysqlDate(session.archivedAt), this.mysqlDate(session.startedAt), this.mysqlDate(session.createdAt), this.mysqlDate(session.updatedAt), JSON.stringify(document)]);
  }
  private compactSandboxSession(session: Session) {
    const { turns, historyNextCursor: _cursor, ...metadata } = session;
    const pendingTurns = turns.filter(turn => turn.codexAccepted && turn.status === 'running')
      .map(turn => ({ ...turn, images: [], items: [], itemTimestamps: {},
        contextUsage: undefined, sdkUsage: undefined, usage: undefined }));
    return persistedSession({ ...metadata, turnCount: Math.max(session.turnCount ?? 0,
      turns.filter(turn => turn.codexAccepted || turn.nativeTurnId).length),
      ...(pendingTurns.length ? { pendingTurns } : {}) } as Session);
  }
  private mysqlDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp in web state: ${value}`);
    return date.toISOString().slice(0, 23).replace('T', ' ');
  }
}

export function createWebStateStore(mysqlUrl?: string): WebStateStore & ImageCatalogStore { return new MySqlWebStateStore(requireMySqlUrl(mysqlUrl)); }
