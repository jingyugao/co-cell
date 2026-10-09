import { traced } from '@co-cell/sandbox';
import type { ImageCatalogStore, ImageRecord } from '../../images/store.js';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import type { Project, Session, Turn } from '../../../protocol/types.js';
import type { SandboxState } from '../../../protocol/sandbox-types.js';
import { MySqlSecretRepository } from '../../secrets/repository.js';
import { MySqlNotificationRepository } from '../../notifications/repository.js';
import { HttpError } from '../../../util/errors.js';
import { mergeRecord } from './record-merge.js';

export interface WebStateStore {
  init(): Promise<void>; listProjects(): Promise<Project[]>; listSessions(): Promise<Session[]>;
  getProject(id: string): Promise<Project | undefined>; getSession(id: string): Promise<Session | undefined>;
  saveProject(project: Project, previous?: Project): Promise<void>; saveSession(session: Session, previous?: Session): Promise<void>;
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
  private preserveLiveItems: boolean;
  readonly secretRepository: MySqlSecretRepository;
  readonly notificationRepository: MySqlNotificationRepository;
  constructor(url: string, options: { preserveLiveItems?: boolean } = {}) {
    this.preserveLiveItems = options.preserveLiveItems ?? false;
    this.pool = createPool({ uri: requireMySqlUrl(url), connectionLimit: 10, charset: 'utf8mb4', timezone: 'Z' });
    this.secretRepository = new MySqlSecretRepository(this.pool);
    this.notificationRepository = new MySqlNotificationRepository(this.pool);
  }
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
    await this.notificationRepository.init();
  }
  async listProjects(): Promise<Project[]> { const [rows] = await this.pool.query<Array<RowDataPacket & { document: Project | string }>>('SELECT document FROM projects'); return rows.map(row => hydrateProject(this.document<Project>(row.document))); }
  async listSessions(): Promise<Session[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { document: Session | string }>>('SELECT document FROM sessions');
    const sessions: Session[] = [];
    for (const row of rows) {
      // A submission that never reached Codex has no App Server history.
      const session = this.hydrateStoredSession(this.document<Session & { pendingTurns?: Turn[] }>(row.document));
      if (session) sessions.push(session);
    }
    return sessions;
  }
  async getProject(id: string): Promise<Project | undefined> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { document: Project | string }>>('SELECT document FROM projects WHERE id = ?', [id]);
    return rows[0] ? hydrateProject(this.document<Project>(rows[0].document as Project | string)) : undefined;
  }
  async getSession(id: string): Promise<Session | undefined> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { document: Session | string }>>('SELECT document FROM sessions WHERE id = ?', [id]);
    if (!rows[0]) return undefined;
    return this.hydrateStoredSession(this.document<Session & { pendingTurns?: Turn[] }>(rows[0].document as (Session & { pendingTurns?: Turn[] }) | string));
  }
  private hydrateStoredSession(value: Session & { pendingTurns?: Turn[] }): Session | undefined {
    const stored = hydrateSession(value);
    if (stored.settings.executionMode !== 'sandbox') return stored;
    const oldTurns = stored.turns ?? [];
    const pendingTurns = stored.pendingTurns ?? oldTurns.filter(turn => turn.status === 'running');
    const acceptedCount = oldTurns.filter(turn => turn.codexAccepted || turn.nativeTurnId).length;
    const session: Session = { ...stored, turns: pendingTurns, turnCount: Math.max(stored.turnCount ?? 0, acceptedCount) };
    delete (session as Session & { pendingTurns?: Turn[] }).pendingTurns;
    if (!session.threadId && !session.turnCount && session.status !== 'idle' && !pendingTurns.length) return undefined;
    return session;
  }
  saveProject(project: Project, previous?: Project): Promise<void> {
    if (previous && previous.id !== project.id) return Promise.reject(new HttpError(409, '不能将记录基线用于其他记录'));
    return previous ? this.mergeAndSave('projects', project.id, persistedProject(previous), persistedProject(project), async (executor, _id, merged) => {
      await this.saveProjectDocumentWith(executor, merged as Project, merged);
    })
      : this.saveProjectWith(this.pool, project);
  }
  saveSession(session: Session, previous?: Session): Promise<void> {
    if (previous && previous.id !== session.id) return Promise.reject(new HttpError(409, '不能将记录基线用于其他记录'));
    const previousDoc = previous ? this.persistedSessionForStorage(previous) : undefined;
    const nextDoc = this.persistedSessionForStorage(session);
    return previous && previousDoc
      ? this.mergeAndSave('sessions', session.id, previousDoc, nextDoc, async (executor, _id, merged) => {
        await this.saveSessionDocumentWith(executor, merged as Session, merged);
      }, (before, desired, latest) => this.preserveTerminalInputAnswers(before, desired, latest, session))
      : this.saveSessionWith(this.pool, session);
  }
  async deleteProject(id: string) { await this.pool.query('DELETE FROM projects WHERE id = ?', [id]); }
  async deleteSession(id: string) { await this.pool.query('DELETE FROM sessions WHERE id = ?', [id]); }
  async close() { await this.pool.end(); }
  private document<T>(value: T | string): T { return typeof value === 'string' ? JSON.parse(value) as T : value; }
  private persistedSessionForStorage(session: Session) {
    return session.settings.executionMode === 'sandbox' ? this.compactSandboxSession(session) : persistedSession(session);
  }
  private preserveTerminalInputAnswers(previous: unknown, incoming: unknown, latest: unknown, session: Session): unknown {
    if (session.settings.executionMode !== 'sandbox' || session.status === 'running') return incoming;
    if (!previous || !incoming || !latest || typeof previous !== 'object' || typeof incoming !== 'object' || typeof latest !== 'object') return incoming;
    const before = previous as Record<string, unknown>;
    const desired = incoming as Record<string, unknown>;
    const current = latest as Record<string, unknown>;
    if ('pendingTurns' in desired || !Array.isArray(before.pendingTurns) || !Array.isArray(current.pendingTurns)) return incoming;
    const beforeTurns = before.pendingTurns as Array<Turn & { id: string }>;
    const latestTurns = current.pendingTurns as Array<Turn & { id: string }>;
    const ids = (turns: Array<{ id: string }>) => turns.map(turn => turn.id).sort();
    const beforeIds = ids(beforeTurns);
    if (!beforeIds.length || JSON.stringify(beforeIds) !== JSON.stringify(ids(latestTurns))) return incoming;
    const terminalTurns = session.turns.filter(turn => beforeIds.includes(turn.id) && (turn.codexAccepted || turn.nativeTurnId))
      .map(turn => ({ ...turn, images: [], items: [], itemTimestamps: {}, contextUsage: undefined, sdkUsage: undefined, usage: undefined }));
    if (JSON.stringify(beforeIds) !== JSON.stringify(ids(terminalTurns))) return incoming;
    const latestById = new Map(latestTurns.map(turn => [turn.id, turn]));
    const beforeById = new Map(beforeTurns.map(turn => [turn.id, turn]));
    const hasNewInputAnswer = beforeIds.some(id => JSON.stringify(beforeById.get(id)?.userInputRequests)
      !== JSON.stringify(latestById.get(id)?.userInputRequests));
    const hasQueuedReply = terminalTurns.some(turn => turn.userInputRequests?.some(request => request.status === 'queued'));
    if (!hasNewInputAnswer && !hasQueuedReply) return incoming;
    return { ...desired, pendingTurns: terminalTurns };
  }
  private async mergeAndSave(table: 'projects' | 'sessions', id: string, previous: unknown, incoming: unknown,
    save: (executor: Pick<Pool, 'query'>, id: string, merged: unknown) => Promise<void>,
    prepareIncoming: (previous: unknown, incoming: unknown, latest: unknown) => unknown = (_previous, next) => next) {
    if (!this.pool.getConnection) throw new Error('MySQL pool does not support transactions');
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<Array<RowDataPacket & { document: unknown }>>(`SELECT document FROM ${table} WHERE id = ? FOR UPDATE`, [id]);
      if (!rows[0]) throw new HttpError(409, '记录已被删除，请刷新后重试');
      const latest = typeof rows[0].document === 'string' ? JSON.parse(rows[0].document) as unknown : rows[0].document;
      const effectiveIncoming = prepareIncoming(previous, incoming, latest);
      const merged = mergeRecord(previous, effectiveIncoming, latest);
      await save(connection, id, merged);
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  private async saveProjectWith(executor: Pick<Pool, 'query'>, project: Project) {
    await this.saveProjectDocumentWith(executor, project, persistedProject(project));
  }
  private async saveProjectDocumentWith(executor: Pick<Pool, 'query'>, project: Project, document: unknown) {
    await traced('mysql.projects.upsert', { 'project.id': project.id, 'operation.id': project.sandboxOperation?.id, 'operation.status': project.sandboxOperation?.status }, () => executor.query(`INSERT INTO projects (id,name,requirement_url,execution_mode,working_directory,archived_at,created_at,updated_at,document) VALUES (?,?,?,?,?,?,?,?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE name=VALUES(name),requirement_url=VALUES(requirement_url),execution_mode=VALUES(execution_mode),working_directory=VALUES(working_directory),archived_at=VALUES(archived_at),updated_at=VALUES(updated_at),document=VALUES(document)`, [project.id, project.name, project.requirementUrl, project.executionMode, project.workingDirectory, this.mysqlDate(project.archivedAt), this.mysqlDate(project.createdAt), this.mysqlDate(project.updatedAt), JSON.stringify(document)]));
  }
  private async saveSessionWith(executor: Pick<Pool, 'query'>, session: Session) {
    const document = session.settings.executionMode === 'sandbox' ? this.compactSandboxSession(session) : persistedSession(session);
    await this.saveSessionDocumentWith(executor, session, document);
  }
  private async saveSessionDocumentWith(executor: Pick<Pool, 'query'>, session: Session, document: unknown) {
    await traced('mysql.sessions.upsert', { 'session.id': session.id, 'project.id': session.projectId }, () => executor.query(`INSERT INTO sessions (id,project_id,thread_id,title,status,archived_at,started_at,created_at,updated_at,document) VALUES (?,?,?,?,?,?,?,?,?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE project_id=VALUES(project_id),thread_id=VALUES(thread_id),title=VALUES(title),status=VALUES(status),archived_at=VALUES(archived_at),started_at=VALUES(started_at),updated_at=VALUES(updated_at),document=VALUES(document)`, [session.id, session.projectId ?? null, session.threadId, session.title, session.status, this.mysqlDate(session.archivedAt), this.mysqlDate(session.startedAt), this.mysqlDate(session.createdAt), this.mysqlDate(session.updatedAt), JSON.stringify(document)]));
  }
  private compactSandboxSession(session: Session) {
    const { turns, historyNextCursor: _cursor, ...metadata } = session;
    const latestAcceptedTerminal = [...turns].reverse().find(turn => turn.status !== 'running' && (turn.codexAccepted || turn.nativeTurnId));
    // Keep lightweight control metadata for running turns and turns with native
    // user-input requests. A queued answer must survive terminal compaction, and
    // answered request metadata must remain in the baseline until the caller
    // removes it so a later save can merge that removal cleanly. Keep the latest
    // accepted terminal turn too, so other API instances can resolve its web ID
    // to the native turn ID and observe completion without retaining its body.
    const pendingTurns = turns.filter(turn => turn.status === 'running' || !!turn.userInputRequests?.length || turn === latestAcceptedTerminal)
      .map(turn => ({ ...turn, prompt: turn.status === 'running' ? turn.prompt : '', images: [],
        items: this.preserveLiveItems && turn.status === 'running' ? turn.items : [],
        itemTimestamps: this.preserveLiveItems && turn.status === 'running' ? turn.itemTimestamps : {},
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

export function createWebStateStore(mysqlUrl?: string, options: { preserveLiveItems?: boolean } = {}) {
  return new MySqlWebStateStore(requireMySqlUrl(mysqlUrl), options);
}
