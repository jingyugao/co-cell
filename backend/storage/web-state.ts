import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import type { Project, Session } from '../../shared/types.js';

export interface WebStateStore {
  init(): Promise<void>; listProjects(): Promise<Project[]>; listSessions(): Promise<Session[]>;
  saveProject(project: Project): Promise<void>; saveSession(session: Session): Promise<void>;
  deleteProject(id: string): Promise<void>; deleteSession(id: string): Promise<void>; close(): Promise<void>;
}

/** JSON is a compatibility source; MySQL installations import it once then stop writing it. */
export class JsonWebStateStore implements WebStateStore {
  private projectsDirectory: string;
  constructor(private directory: string) { this.projectsDirectory = join(directory, 'projects'); }
  async init() { await Promise.all([mkdir(this.directory, { recursive: true, mode: 0o700 }), mkdir(this.projectsDirectory, { recursive: true, mode: 0o700 })]); }
  private async records<T>(directory: string): Promise<T[]> {
    const names = await readdir(directory);
    return Promise.all(names.filter(name => /^[\da-f-]{36}\.json$/.test(name)).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as T));
  }
  listProjects(): Promise<Project[]> { return this.records<Project>(this.projectsDirectory); }
  listSessions(): Promise<Session[]> { return this.records<Session>(this.directory); }
  saveProject(project: Project): Promise<void> { return this.write(join(this.projectsDirectory, `${project.id}.json`), project); }
  saveSession(session: Session): Promise<void> { return this.write(join(this.directory, `${session.id}.json`), session); }
  deleteProject(id: string): Promise<void> { return rm(join(this.projectsDirectory, `${id}.json`), { force: true }); }
  deleteSession(id: string): Promise<void> { return rm(join(this.directory, `${id}.json`), { force: true }); }
  async close() {}
  private async write(file: string, value: unknown) { await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 }); await rename(`${file}.tmp`, file); }
}

/** Web metadata only; E2B storage and sandbox-local ~/.codex are intentionally separate. */
export class MySqlWebStateStore implements WebStateStore {
  private pool: Pool;
  constructor(url: string, private legacy: JsonWebStateStore) { this.pool = createPool({ uri: url, connectionLimit: 10, charset: 'utf8mb4', timezone: 'Z' }); }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS web_schema_migrations (name VARCHAR(191) PRIMARY KEY, applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS projects (id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, requirement_url TEXT NULL, execution_mode ENUM('e2b','local') NOT NULL, working_directory TEXT NOT NULL, archived_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, document JSON NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS sessions (id CHAR(36) PRIMARY KEY, project_id CHAR(36) NULL, thread_id VARCHAR(191) NULL, title VARCHAR(255) NOT NULL, status ENUM('idle','running','completed','failed','cancelled') NOT NULL, archived_at DATETIME(3) NULL, started_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, document JSON NOT NULL, INDEX sessions_project_updated (project_id, updated_at), CONSTRAINT sessions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await this.importLegacyOnce();
  }
  private async importLegacyOnce() {
    const [rows] = await this.pool.query<Array<RowDataPacket & { name: string }>>('SELECT name FROM web_schema_migrations WHERE name = ?', ['legacy-json-v1']);
    if (rows.length) return;
    await this.legacy.init();
    const [projects, sessions] = await Promise.all([this.legacy.listProjects(), this.legacy.listSessions()]);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const project of projects) await this.saveProjectWith(connection, project);
      for (const session of sessions) await this.saveSessionWith(connection, session);
      await connection.query('INSERT IGNORE INTO web_schema_migrations (name) VALUES (?)', ['legacy-json-v1']);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async listProjects(): Promise<Project[]> { const [rows] = await this.pool.query<Array<RowDataPacket & { document: Project | string }>>('SELECT document FROM projects'); return rows.map(row => this.document<Project>(row.document)); }
  async listSessions(): Promise<Session[]> { const [rows] = await this.pool.query<Array<RowDataPacket & { document: Session | string }>>('SELECT document FROM sessions'); return rows.map(row => this.document<Session>(row.document)); }
  saveProject(project: Project): Promise<void> { return this.saveProjectWith(this.pool, project); }
  saveSession(session: Session): Promise<void> { return this.saveSessionWith(this.pool, session); }
  async deleteProject(id: string) { await this.pool.query('DELETE FROM projects WHERE id = ?', [id]); }
  async deleteSession(id: string) { await this.pool.query('DELETE FROM sessions WHERE id = ?', [id]); }
  async close() { await this.pool.end(); }
  private document<T>(value: T | string): T { return typeof value === 'string' ? JSON.parse(value) as T : value; }
  private async saveProjectWith(executor: Pick<Pool, 'query'>, project: Project) {
    await executor.query(`INSERT INTO projects (id,name,requirement_url,execution_mode,working_directory,archived_at,created_at,updated_at,document) VALUES (?,?,?,?,?,?,?,?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE name=VALUES(name),requirement_url=VALUES(requirement_url),execution_mode=VALUES(execution_mode),working_directory=VALUES(working_directory),archived_at=VALUES(archived_at),updated_at=VALUES(updated_at),document=VALUES(document)`, [project.id, project.name, project.requirementUrl, project.executionMode, project.workingDirectory, this.mysqlDate(project.archivedAt), this.mysqlDate(project.createdAt), this.mysqlDate(project.updatedAt), JSON.stringify(project)]);
  }
  private async saveSessionWith(executor: Pick<Pool, 'query'>, session: Session) {
    await executor.query(`INSERT INTO sessions (id,project_id,thread_id,title,status,archived_at,started_at,created_at,updated_at,document) VALUES (?,?,?,?,?,?,?,?,?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE project_id=VALUES(project_id),thread_id=VALUES(thread_id),title=VALUES(title),status=VALUES(status),archived_at=VALUES(archived_at),started_at=VALUES(started_at),updated_at=VALUES(updated_at),document=VALUES(document)`, [session.id, session.projectId ?? null, session.threadId, session.title, session.status, this.mysqlDate(session.archivedAt), this.mysqlDate(session.startedAt), this.mysqlDate(session.createdAt), this.mysqlDate(session.updatedAt), JSON.stringify(session)]);
  }
  private mysqlDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp in web state: ${value}`);
    return date.toISOString().slice(0, 23).replace('T', ' ');
  }
}

export function createWebStateStore(directory: string, mysqlUrl?: string): WebStateStore { const legacy = new JsonWebStateStore(directory); return mysqlUrl ? new MySqlWebStateStore(mysqlUrl, legacy) : legacy; }
