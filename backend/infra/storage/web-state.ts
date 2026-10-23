import { MySqlPreviewGrantStore } from '../../access/preview-grants.js';
import { MySqlModelRepository } from '../../models/repository.js';
import { MySqlMemoryRepository } from '../../memory/repository.js';
import type { ImageCatalogStore, ImageRecord } from '../../images/store.js';
import type { DefaultImageSelection } from '../../../protocol/image-types.js';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import type { Project, Session, Turn } from '../../../protocol/types.js';
import type { InputRequestRecord } from '../../../protocol/input-request-types.js';
import { MySqlSecretRepository } from '../../secrets/repository.js';
import { MySqlToolRepository } from '../../tools/repository.js';
import { MySqlNotificationRepository, saveNotificationsInTransaction } from '../../notifications/repository.js';
import { applyNativeEvent, type NativeBusinessEvent } from '../../sessions/native-events.js';
import { collectNativeUserInputAnswers, withNativeUserInput, type NativeUserInputAnswers } from '../../../util/user-input.js';
import { HttpError } from '../../../util/errors.js';
import { mergeRecord } from './record-merge.js';
import { date, fromJson, iso, inputRequestFromRow, mainTurnValues, projectFromRow, projectValues, PROJECT_COLUMNS, requestTurnValues, SESSION_COLUMNS, sessionFromRow, sessionValues, turnFromRow, type SessionTurnRow } from './relational-records.js';

export interface WebStateStore {
  init(): Promise<void>; listProjects(): Promise<Project[]>; listSessions(): Promise<Session[]>;
  listProjectSessions(projectId: string): Promise<Session[]>;
  getProject(id: string): Promise<Project | undefined>; getSession(id: string): Promise<Session | undefined>;
  /** The synchronous mutation runs against the latest project in a short transaction. */
  mutateProject(id: string, mutate: (current: Project) => void): Promise<Project>;
  saveProject(project: Project, previous?: Project): Promise<void>; saveSession(session: Session, previous?: Session, metadataOnly?: boolean): Promise<void>;
  saveInputRequest?(request: InputRequestRecord): Promise<void>; listInputRequests?(sessionId: string): Promise<InputRequestRecord[]>;
  /** Deduplication, projection, notifications and result reads share one transaction. */
  consumeNativeEvents?(events: NativeBusinessEvent[]): Promise<Session | undefined>;
  deleteProject(id: string): Promise<void>; deleteSession(id: string): Promise<void>; close(): Promise<void>;
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
  readonly previewGrants: MySqlPreviewGrantStore;
  readonly modelRepository: MySqlModelRepository;
  readonly memoryRepository: MySqlMemoryRepository;
  readonly secretRepository: MySqlSecretRepository;
  readonly toolRepository: MySqlToolRepository;
  readonly notificationRepository: MySqlNotificationRepository;
  constructor(url: string) {
    this.pool = createPool({ uri: requireMySqlUrl(url), connectionLimit: 10, charset: 'utf8mb4', timezone: 'Z' });
    this.previewGrants = new MySqlPreviewGrantStore(this.pool);
    this.modelRepository = new MySqlModelRepository(this.pool);
    this.memoryRepository = new MySqlMemoryRepository(this.pool);
    this.secretRepository = new MySqlSecretRepository(this.pool);
    this.toolRepository = new MySqlToolRepository(this.pool);
    this.notificationRepository = new MySqlNotificationRepository(this.pool);
  }
  async listImages(): Promise<ImageRecord[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { document: ImageRecord | string }>>('SELECT document FROM managed_images');
    return rows.map(row => this.document<ImageRecord>(row.document));
  }
  async saveImage(image: ImageRecord) {
    await this.pool.query('INSERT INTO managed_images (id,document) VALUES (?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE document=VALUES(document)', [image.id, JSON.stringify(image)]);
  }
  async loadDefaultImage(): Promise<DefaultImageSelection | undefined> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { document: DefaultImageSelection | string }>>("SELECT document FROM image_settings WHERE name='default'");
    return rows[0] ? this.document<DefaultImageSelection>(rows[0].document) : undefined;
  }
  async saveDefaultImage(selection: DefaultImageSelection | undefined, image?: ImageRecord) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (selection) await connection.query("INSERT INTO image_settings (name,document) VALUES ('default',CAST(? AS JSON)) ON DUPLICATE KEY UPDATE document=VALUES(document)", [JSON.stringify(selection)]);
      else await connection.query("DELETE FROM image_settings WHERE name='default'");
      if (image) await connection.query('INSERT INTO managed_images (id,document) VALUES (?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE document=VALUES(document)', [image.id, JSON.stringify(image)]);
      await connection.commit();
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  async init() {
    await this.previewGrants.init();
    await this.pool.query(`CREATE TABLE IF NOT EXISTS managed_images (id CHAR(36) PRIMARY KEY, document JSON NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS image_settings (name VARCHAR(100) PRIMARY KEY, document JSON NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const [existing] = await this.pool.query<Array<RowDataPacket & { TABLE_NAME: string; COLUMN_NAME: string }>>(`SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('projects','sessions') AND COLUMN_NAME='document'`);
    if (existing.length) throw new Error('Legacy projects/sessions document tables must be archived first. Stop the old CoCell instances, then run pnpm metadata:archive-legacy against the same MYSQL_URL. Other tables and archived data are preserved.');
    await this.pool.query(`CREATE TABLE IF NOT EXISTS projects (
      id CHAR(36) PRIMARY KEY,name VARCHAR(100) NOT NULL,type TINYINT UNSIGNED NOT NULL DEFAULT 1,week_of DATE NULL,
      requirement_url TEXT NULL,requirement_status VARCHAR(255) NULL,execution_mode ENUM('sandbox','local') NOT NULL,
      working_directory TEXT NOT NULL,status ENUM('active','completed','archived','deleting') NOT NULL DEFAULT 'active',current_box_id VARCHAR(200) NULL,
      sandbox_owner_key VARCHAR(255) NULL,sandbox_template VARCHAR(200) NULL,sandbox_working_directory TEXT NULL,mounts_json JSON NULL,
      sandbox_image_reference TEXT NULL,sandbox_image_id TEXT NULL,sandbox_image_repo_digests_json JSON NULL,sandbox_image_version VARCHAR(255) NULL,
      sandbox_image_template_id VARCHAR(200) NULL,sandbox_image_revision_id VARCHAR(200) NULL,home_volume_id VARCHAR(200) NULL,
      sandbox_last_active_at DATETIME(3) NULL,sandbox_paused_at DATETIME(3) NULL,sandbox_reclaimed_at DATETIME(3) NULL,sandbox_artifacts_cleaned_at DATETIME(3) NULL,
      image_catalog_id VARCHAR(200) NULL,image_name VARCHAR(255) NULL,image_category VARCHAR(255) NULL,image_version_id VARCHAR(200) NULL,
      image_version VARCHAR(255) NULL,template_id VARCHAR(200) NULL,revision_id VARCHAR(200) NULL,image_reference TEXT NULL,image_migration_required BOOLEAN NULL,
      sandbox_operation_json JSON NULL,sandbox_backup_json JSON NULL,latest_backup_json JSON NULL,
      remote_archives_json JSON NULL,pending_sandbox_cleanup_json JSON NULL,pending_volume_cleanup_json JSON NULL,
      archive_cleanup_source_id VARCHAR(200) NULL,lifecycle_history_json JSON NULL,removed_at DATETIME(3) NULL,completed_at DATETIME(3) NULL,
      archived_at DATETIME(3) NULL,created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY projects_current_box (current_box_id),INDEX projects_status_updated(status,updated_at),INDEX projects_type_week(type,week_of)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS app_server_events (
      event_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      session_id CHAR(36) NOT NULL,thread_id VARCHAR(191) NOT NULL,turn_id VARCHAR(200) NOT NULL,
      kind ENUM('turn','input','usage','question') NOT NULL,payload_json JSON NOT NULL,
      event_at DATETIME(3) NOT NULL,received_at DATETIME(3) NOT NULL,
      INDEX app_server_events_session(session_id,kind),INDEX app_server_events_turn(session_id,thread_id,turn_id,kind,event_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const [projectStatus] = await this.pool.query<Array<RowDataPacket & { COLUMN_TYPE: string }>>(
      "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='projects' AND COLUMN_NAME='status'");
    if (projectStatus.length && !projectStatus[0].COLUMN_TYPE.includes("'deleting'"))
      await this.pool.query("ALTER TABLE projects MODIFY COLUMN status ENUM('active','completed','archived','deleting') NOT NULL DEFAULT 'active'");
    await this.pool.query(`CREATE TABLE IF NOT EXISTS sessions (
      id CHAR(36) PRIMARY KEY,project_id CHAR(36) NULL,thread_id VARCHAR(191) NULL,native_history_path TEXT NULL,title VARCHAR(255) NOT NULL,
      execution_mode ENUM('sandbox','local') NOT NULL,working_directory TEXT NOT NULL,model VARCHAR(200) NOT NULL,model_entry_id VARCHAR(200) NULL,
      model_reasoning_effort VARCHAR(20) NOT NULL,sandbox_mode VARCHAR(32) NOT NULL,web_search_mode VARCHAR(16) NOT NULL,
      network_access_enabled BOOLEAN NOT NULL,status ENUM('idle','running','completed','failed','cancelled') NOT NULL,
      turn_count BIGINT UNSIGNED NOT NULL DEFAULT 0,context_input_tokens BIGINT UNSIGNED NULL,context_cached_input_tokens BIGINT UNSIGNED NULL,
      context_output_tokens BIGINT UNSIGNED NULL,context_model VARCHAR(200) NULL,context_observed_at DATETIME(3) NULL,
      context_source ENUM('responses','rollout') NULL,archived_at DATETIME(3) NULL,started_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,INDEX sessions_project_updated(project_id,updated_at),
      INDEX sessions_status(status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS session_turns (
      id CHAR(36) PRIMARY KEY,session_id CHAR(36) NOT NULL,target_turn_id CHAR(36) NOT NULL,type ENUM('message','steer','question_reply') NOT NULL,
      method VARCHAR(32) NULL,params_json JSON NULL,thread_request_json JSON NULL,input_text MEDIUMTEXT NOT NULL,images_json JSON NULL,
      delivery_status ENUM('queued','sending','accepted','failed','unknown') NOT NULL DEFAULT 'queued',native_turn_id VARCHAR(200) NULL,
      sent_at DATETIME(3) NULL,accepted_at DATETIME(3) NULL,request_error TEXT NULL,
      codex_accepted BOOLEAN NOT NULL DEFAULT FALSE,turn_status ENUM('idle','running','completed','failed','cancelled') NOT NULL DEFAULT 'running',
      question_request_id VARCHAR(191) NULL,input_tokens BIGINT UNSIGNED NULL,cached_input_tokens BIGINT UNSIGNED NULL,
      cache_write_input_tokens BIGINT UNSIGNED NULL,output_tokens BIGINT UNSIGNED NULL,reasoning_output_tokens BIGINT UNSIGNED NULL,
      sdk_input_tokens BIGINT UNSIGNED NULL,sdk_cached_input_tokens BIGINT UNSIGNED NULL,sdk_cache_write_input_tokens BIGINT UNSIGNED NULL,
      sdk_output_tokens BIGINT UNSIGNED NULL,sdk_reasoning_output_tokens BIGINT UNSIGNED NULL,
      started_at DATETIME(3) NOT NULL,completed_at DATETIME(3) NULL,error TEXT NULL,
      INDEX session_turns_target(session_id,target_turn_id),INDEX session_turns_session(session_id,started_at),
      INDEX session_turns_native(session_id,native_turn_id),INDEX session_turns_question_request(session_id,question_request_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const [foreignKeys] = await this.pool.query<Array<RowDataPacket & { TABLE_NAME: string; CONSTRAINT_NAME: string }>>(
      "SELECT TABLE_NAME,CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME IN ('sessions','session_turns') AND CONSTRAINT_TYPE='FOREIGN KEY'");
    for (const key of foreignKeys) {
      const name = key.CONSTRAINT_NAME.replaceAll('`', '``');
      const table = key.TABLE_NAME.replaceAll('`', '``');
      await this.pool.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``);
    }
    const [schemaColumns] = await this.pool.query<Array<RowDataPacket & { TABLE_NAME: string; COLUMN_NAME: string }>>(
      `SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND
       ((TABLE_NAME='projects' AND COLUMN_NAME IN ('current_box_id','image_catalog_id','mounts_json')) OR
        (TABLE_NAME='sessions' AND COLUMN_NAME IN ('model','execution_mode','turn_count')) OR
        (TABLE_NAME='session_turns' AND COLUMN_NAME IN ('target_turn_id','params_json','question_request_id','sdk_input_tokens','sdk_cached_input_tokens','sdk_cache_write_input_tokens','sdk_output_tokens','sdk_reasoning_output_tokens'))) `);
    const schemaKeys = new Set(schemaColumns.map(column => `${column.TABLE_NAME}.${column.COLUMN_NAME}`));
    const expectedSchemaKeys = ['projects.current_box_id','projects.image_catalog_id','projects.mounts_json',
      'sessions.model','sessions.execution_mode','sessions.turn_count','session_turns.target_turn_id','session_turns.params_json','session_turns.question_request_id',
      'session_turns.sdk_input_tokens','session_turns.sdk_cached_input_tokens','session_turns.sdk_cache_write_input_tokens','session_turns.sdk_output_tokens','session_turns.sdk_reasoning_output_tokens'];
    if (expectedSchemaKeys.some(key => !schemaKeys.has(key))) throw new Error('CoCell relational metadata schema is incomplete; restore a complete schema before starting. The metadata archive command only handles the legacy document schema.');
    const [questionIndex] = await this.pool.query<Array<RowDataPacket & { INDEX_NAME: string }>>(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='session_turns' AND INDEX_NAME='session_turns_question_request' LIMIT 1`);
    if (!questionIndex.length) throw new Error('CoCell session_turns question request index is missing; automatic schema migration is disabled.');
    await this.notificationRepository.init();
  }
  async listProjects(): Promise<Project[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(`SELECT ${PROJECT_COLUMNS} FROM projects`);
    return rows.map(projectFromRow);
  }
  async listSessions(): Promise<Session[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(`SELECT ${SESSION_COLUMNS} FROM sessions`);
    return this.hydrateSessions(rows, this.pool, false);
  }
  async listProjectSessions(projectId: string): Promise<Session[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE project_id = ?`, [projectId]);
    return this.hydrateSessions(rows, this.pool, false);
  }
  private async hydrateSessions(rows: Array<Record<string, unknown>>, executor: Pick<Pool, 'query'> = this.pool, nativeMetadata = true): Promise<Session[]> {
    if (!rows.length) return [];
    const ids = rows.map(row => String(row.id));
    const placeholders = ids.map(() => '?').join(',');
    const [turnRows] = await executor.query<Array<RowDataPacket & SessionTurnRow>>(
      `SELECT id,session_id,target_turn_id,type,input_text,images_json,native_turn_id,codex_accepted,turn_status,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,sdk_input_tokens,sdk_cached_input_tokens,sdk_cache_write_input_tokens,sdk_output_tokens,sdk_reasoning_output_tokens,started_at,completed_at,error
       FROM session_turns st WHERE st.session_id IN (${placeholders}) AND st.id=st.target_turn_id AND
       (st.turn_status='running' OR st.id=(SELECT st2.id FROM session_turns st2 WHERE st2.session_id=st.session_id AND st2.id=st2.target_turn_id
       ORDER BY st2.started_at DESC,st2.id DESC LIMIT 1)) ORDER BY started_at`, ids);
    const bySession = new Map<string, Turn[]>();
    for (const row of turnRows) { const list = bySession.get(row.session_id) ?? []; list.push(turnFromRow(row)); bySession.set(row.session_id, list); }
    const projects = new Map<string, Project>();
    const projectIds = [...new Set(rows.map(r => r.project_id).filter((v): v is string => typeof v === 'string'))];
    if (projectIds.length) {
      const [projectRows] = await executor.query<Array<RowDataPacket & Record<string, unknown>>>(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id IN (${projectIds.map(() => '?').join(',')})`, projectIds);
      for (const row of projectRows) projects.set(String(row.id), projectFromRow(row));
    }
    const sessions = rows.map(row => {
      const session = sessionFromRow(row); session.turns = bySession.get(session.id) ?? [];
      const project = session.projectId ? projects.get(session.projectId) : undefined;
      if (project?.sandbox) session.sandbox = project.sandbox;
      if (project?.imageSelection) session.imageSelection = project.imageSelection;
      return session;
    });
    if (nativeMetadata) await this.hydrateNativeMetadata(sessions, executor);
    return sessions;
  }

  private async hydrateNativeMetadata(sessions: Session[], executor: Pick<Pool, 'query'>) {
    const native = sessions.filter(session => session.settings.executionMode === 'sandbox' && session.threadId);
    if (!native.length) return;
    const ids = native.map(session => session.id);
    const placeholders = ids.map(() => '?').join(',');
    const [inputs] = await executor.query<Array<RowDataPacket & SessionTurnRow>>(
      `SELECT * FROM session_turns WHERE session_id IN (${placeholders}) AND id<>target_turn_id
       AND type IN ('steer','question_reply') AND delivery_status='accepted' ORDER BY started_at,id`, ids);
    const [questions] = await executor.query<Array<RowDataPacket & { session_id: string; thread_id: string; turn_id: string; payload_json: unknown }>>(
      `SELECT session_id,thread_id,turn_id,payload_json FROM app_server_events WHERE session_id IN (${placeholders}) AND kind='question' ORDER BY received_at,event_key`, ids);
    for (const session of native) {
      for (const turn of session.turns) {
        turn.additionalUserInputs = inputs.filter(input => input.session_id === session.id && input.target_turn_id === turn.id).map(input => input.input_text);
        for (const row of questions) {
          if (row.session_id !== session.id || row.thread_id !== session.threadId || row.turn_id !== turn.nativeTurnId) continue;
          const question = fromJson<NativeBusinessEvent['payload']>(row.payload_json, {}).question;
          if (!question) continue;
          turn.userInputRequests ??= [];
          const previous = turn.userInputRequests.find(value => value.id === question.id);
          if (previous) Object.assign(previous, question, { createdAt: previous.createdAt });
          else turn.userInputRequests.push(question);
        }
      }
      const answers: NativeUserInputAnswers = new Map();
      collectNativeUserInputAnswers(session.turns, answers);
      session.turns = session.turns.map(turn => withNativeUserInput(turn, answers));
    }
  }

  async consumeNativeEvents(events: NativeBusinessEvent[]): Promise<Session | undefined> {
    if (!events.length) return undefined;
    const { sessionId, threadId } = events[0];
    if (events.some(event => event.sessionId !== sessionId || event.threadId !== threadId))
      throw new Error('A native transaction must belong to one session and thread');
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // The same session row also fences deletion and concurrent metadata edits.
      const [rows] = await connection.query<Array<RowDataPacket & Record<string, unknown>>>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id=? FOR UPDATE`, [sessionId]);
      if (!rows[0] || rows[0].thread_id !== threadId || rows[0].execution_mode !== 'sandbox') {
        await connection.commit();
        return undefined;
      }
      let session = sessionFromRow(rows[0]);
      const [turnRows] = await connection.query<Array<RowDataPacket & SessionTurnRow>>(
        'SELECT * FROM session_turns WHERE session_id=? ORDER BY started_at,id FOR UPDATE', [sessionId]);
      session.turns = turnRows.filter(row => row.id === row.target_turn_id).map(turnFromRow);
      await this.hydrateNativeMetadata([session], connection);
      const project = session.projectId ? await this.projectInTransaction(connection, session.projectId) : undefined;
      if (project?.removedAt || project?.status === 'deleting') { await connection.commit(); return undefined; }
      const notifications = [];
      let changed = false;
      for (const event of events) {
        const [seen] = await connection.query<RowDataPacket[]>('SELECT event_key FROM app_server_events WHERE event_key=?', [event.key]);
        if (seen.length) continue;
        changed = true;
        let usageObservedAt: string | undefined;
        let usageTotalTokens: number | undefined;
        if (event.kind === 'usage') {
          const [usage] = await connection.query<Array<RowDataPacket & { observed_at: unknown; total_tokens: number | string | null }>>(
            `SELECT MAX(CASE WHEN JSON_EXTRACT(payload_json,'$.usage.sourceAt') IS NOT NULL THEN event_at END) AS observed_at,
             MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.usage.totalTokens')) AS UNSIGNED)) AS total_tokens
             FROM app_server_events WHERE session_id=? AND thread_id=? AND turn_id=? AND kind='usage'`,
            [sessionId, threadId, event.turnId]);
          usageObservedAt = iso(usage[0]?.observed_at) ?? undefined;
          if (usage[0]?.total_tokens != null) usageTotalTokens = Number(usage[0].total_tokens);
        }
        await connection.query(`INSERT INTO app_server_events (event_key,session_id,thread_id,turn_id,kind,payload_json,event_at,received_at)
          VALUES (?,?,?,?,?,CAST(? AS JSON),?,?)`, [event.key, sessionId, threadId, event.turnId, event.kind, JSON.stringify(event.payload),
          date(event.payload.usage?.observedAt ?? event.receivedAt), date(event.receivedAt)]);
        const result = applyNativeEvent(session, event, { projectName: project?.name, usageObservedAt, usageTotalTokens,
          inputExists: !!event.payload.input && turnRows.some(row => row.id === event.payload.input!.id) });
        session = result.session;
        await this.upsertMainTurn(connection, sessionId, result.turn);
        if (result.input) {
          result.input.turnId = result.turn.id;
          await this.upsertInputRequest(connection, result.input);
        }
        if (result.notification) notifications.push(result.notification);
      }
      if (changed) await this.saveSessionRow(connection, session);
      await saveNotificationsInTransaction(connection, notifications);
      // Read the canonical projection inside this transaction and return only after commit.
      const [finalRows] = await connection.query<Array<RowDataPacket & Record<string, unknown>>>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id=?`, [sessionId]);
      const result = finalRows[0] ? (await this.hydrateSessions(finalRows, connection))[0] : undefined;
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }

  private async projectInTransaction(connection: Pick<Pool, 'query'>, id: string) {
    const [rows] = await connection.query<Array<RowDataPacket & Record<string, unknown>>>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id=?`, [id]);
    return rows[0] ? projectFromRow(rows[0]) : undefined;
  }
  async mutateProject(id: string, mutate: (current: Project) => void): Promise<Project> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<Array<RowDataPacket & Record<string, unknown>>>(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? FOR UPDATE`, [id]);
      if (!rows[0]) throw new HttpError(409, '项目已删除');
      const project = projectFromRow(rows[0]);
      const before = JSON.stringify(projectValues(project));
      mutate(project);
      if (project.id !== id) throw new Error('Project mutation cannot change its identity');
      if (JSON.stringify(projectValues(project)) !== before) await this.saveProjectWith(connection, project);
      await connection.commit();
      return project;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  async getProject(id: string): Promise<Project | undefined> {
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`, [id]);
    return rows[0] ? projectFromRow(rows[0]) : undefined;
  }
  async getSession(id: string): Promise<Session | undefined> {
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, [id]);
    if (!rows[0]) return undefined;
    return (await this.hydrateSessions(rows))[0];
  }
  saveProject(project: Project, previous?: Project): Promise<void> {
    if (previous && previous.id !== project.id) return Promise.reject(new HttpError(409, '不能将记录基线用于其他记录'));
    return previous ? this.mergeProject(project, previous) : this.saveProjectWith(this.pool, project);
  }
  saveSession(session: Session, previous?: Session, metadataOnly = false): Promise<void> {
    if (previous && previous.id !== session.id) return Promise.reject(new HttpError(409, '不能将记录基线用于其他记录'));
    return this.saveSessionRelational(session, previous, metadataOnly);
  }
  async saveInputRequest(request: InputRequestRecord): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<Array<RowDataPacket & { id: string }>>(
        'SELECT id FROM sessions WHERE id=? FOR UPDATE', [request.sessionId]);
      if (!sessionRows[0]) throw new HttpError(409, '会话已删除，不能保存输入请求');
      const [inputRows] = await connection.query<Array<RowDataPacket & { session_id: string; codex_accepted: number | boolean; target_turn_id: string; delivery_status: string }>>(
        'SELECT session_id,codex_accepted,target_turn_id,delivery_status FROM session_turns WHERE id=? FOR UPDATE', [request.id]);
      if (inputRows[0] && inputRows[0].session_id !== request.sessionId) {
        throw new HttpError(409, '输入请求 ID 已属于其他会话');
      }
      const previousStatus = inputRows[0]?.delivery_status;
      if (request.status === 'sending' && ['accepted', 'failed', 'unknown'].includes(previousStatus))
        throw new HttpError(409, '此输入请求已结束或接收状态未知，不能重新发送');
      if (previousStatus === 'accepted' || (previousStatus === 'unknown' && request.status === 'queued')) {
        await connection.commit();
        return;
      }
      const wasAcceptedMain = !!inputRows[0] && Boolean(inputRows[0].codex_accepted)
        && inputRows[0].target_turn_id === request.id;
      const isMainTurn = request.id === request.turnId;
      if (request.status === 'accepted' && isMainTurn && !inputRows[0]) {
        throw new HttpError(409, '主轮次输入尚未保存，不能记录 Codex 已接受状态');
      }
      if (!inputRows[0] && request.type === 'question_reply' && request.requestId) {
        const [activeReplies] = await connection.query<Array<RowDataPacket & { id: string }>>(
          `SELECT id FROM session_turns
           WHERE session_id=? AND question_request_id=? AND type='question_reply'
             AND delivery_status IN ('queued','sending','accepted','unknown') AND id<>? LIMIT 1 FOR UPDATE`,
          [request.sessionId, request.requestId, request.id]);
        if (activeReplies[0]) throw new HttpError(409, '该问题已有待投递或结果未确认的回答');
      }
      await this.upsertInputRequest(connection, request);
      if (request.status === 'accepted' && isMainTurn) {
        const threadId = request.params?.threadId;
        if (typeof threadId === 'string' && threadId.length) {
          await connection.query('UPDATE sessions SET thread_id=? WHERE id=?', [threadId, request.sessionId]);
        }
        if (!wasAcceptedMain) {
          const [countRows] = await connection.query<Array<RowDataPacket & { accepted_count: number | string }>>(
            `SELECT COUNT(*) AS accepted_count FROM session_turns WHERE session_id=? AND id=target_turn_id AND codex_accepted=1`, [request.sessionId]);
          await connection.query('UPDATE sessions SET turn_count=GREATEST(turn_count,?) WHERE id=?',
            [Number(countRows[0]?.accepted_count ?? 0), request.sessionId]);
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  async listInputRequests(sessionId: string): Promise<InputRequestRecord[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & SessionTurnRow>>('SELECT * FROM session_turns WHERE session_id=? ORDER BY started_at,id', [sessionId]);
    return rows.map(inputRequestFromRow);
  }
  async deleteProject(id: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [projects] = await connection.query<RowDataPacket[]>('SELECT id FROM projects WHERE id=? FOR UPDATE', [id]);
      if (!projects.length) { await connection.commit(); return; }
      // Secret repositories are optional for standalone metadata consumers.
      const [tables] = await connection.query<Array<RowDataPacket & { TABLE_NAME: string }>>(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('project_tool_roles','project_tool_runtimes','sandbox_runtime_configs')");
      const present = new Set(tables.map(table => table.TABLE_NAME));
      if (present.has('project_tool_runtimes')) {
        const [runtimes] = await connection.query<Array<RowDataPacket & { box_id: string }>>('SELECT box_id FROM project_tool_runtimes WHERE project_id=? FOR UPDATE', [id]);
        if (present.has('sandbox_runtime_configs')) for (const runtime of runtimes)
          await connection.query('DELETE FROM sandbox_runtime_configs WHERE box_id=?', [runtime.box_id]);
        await connection.query('DELETE FROM project_tool_runtimes WHERE project_id=?', [id]);
      }
      if (present.has('project_tool_roles')) await connection.query('DELETE FROM project_tool_roles WHERE project_id=?', [id]);
      await connection.query('UPDATE sessions SET project_id=NULL WHERE project_id=?', [id]);
      await connection.query('DELETE FROM projects WHERE id=?', [id]);
      await connection.commit();
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  async deleteSession(id: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM sessions WHERE id=? FOR UPDATE', [id]);
      await connection.query('DELETE FROM session_turns WHERE session_id=?', [id]);
      await connection.query('DELETE FROM app_server_events WHERE session_id=?', [id]);
      await connection.query('DELETE FROM sessions WHERE id=?', [id]);
      await connection.commit();
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  async close() { await this.pool.end(); }
  private document<T>(value: T | string): T { return typeof value === 'string' ? JSON.parse(value) as T : value; }
  private async saveProjectWith(executor: Pick<Pool, 'query'>, project: Project) {
    const cols = PROJECT_COLUMNS.split(',').map(column => column.trim()).filter(Boolean);
    const values = projectValues(project);
    const updates = cols.slice(1).map(column => `${column}=VALUES(${column})`).join(',');
    await executor.query(`INSERT INTO projects (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE ${updates}`, values);
  }
  private async mergeProject(incoming: Project, previous: Project) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<Array<RowDataPacket & Record<string, unknown>>>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id=? FOR UPDATE`, [incoming.id]);
      if (!rows[0]) throw new HttpError(409, '记录已被删除，请刷新后重试');
      const latest = projectFromRow(rows[0]);
      const merged = mergeRecord(this.projectMergeShape(previous), this.projectMergeShape(incoming), this.projectMergeShape(latest));
      await this.saveProjectWith(connection, merged);
      await connection.commit();
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  private async saveSessionRelational(session: Session, previous?: Session, metadataOnly = false) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      let deletingProject = false;
      if (session.projectId) {
        const [projects] = await connection.query<RowDataPacket[]>('SELECT id,status FROM projects WHERE id=? AND removed_at IS NULL FOR UPDATE', [session.projectId]);
        if (!projects.length) throw new HttpError(409, '项目已删除，不能保存会话');
        deletingProject = projects[0].status === 'deleting';
      }
      const [found] = await connection.query<Array<RowDataPacket & Record<string, unknown>>>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id=? FOR UPDATE`, [session.id]);
      if (!found[0] && deletingProject) throw new HttpError(409, '项目正在删除，不能创建会话');
      let effective = session;
      if (previous && !found[0]) throw new HttpError(409, '记录已被删除，请刷新后重试');
      if (found[0] && previous) {
        const latest = sessionFromRow(found[0]);
        effective = { ...mergeRecord(this.sessionMergeShape(previous), this.sessionMergeShape(session), this.sessionMergeShape(latest)), turns: session.turns } as Session;
      }
      if (metadataOnly && found[0]) {
        const latest = sessionFromRow(found[0]);
        effective = { ...effective, status: latest.status, turnCount: latest.turnCount, contextUsage: latest.contextUsage };
      }
      await this.saveSessionRow(connection, effective);
      // Save only the active/control turns already present in the web session. Native history
      // loaded for display is never imported; existing rows remain untouched when omitted.
      const turns = effective.turns ?? [];
      const active = turns.filter(turn => !!turn.type);
      if (!metadataOnly) for (const turn of active) await this.upsertMainTurn(connection, effective.id, turn);
      await connection.commit();
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  private async saveSessionRow(executor: Pick<Pool, 'query'>, session: Session) {
    const cols = SESSION_COLUMNS.split(',').map(column => column.trim()).filter(Boolean);
    const values = sessionValues(session);
    const updates = cols.slice(1).map(column => column === 'turn_count' ? 'turn_count=GREATEST(turn_count,VALUES(turn_count))' : `${column}=VALUES(${column})`).join(',');
    await executor.query(`INSERT INTO sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE ${updates}`, values);
  }
  private projectMergeShape(project: Project): Project {
    const { status: _status, statusError: _statusError, ...sandbox } = (project.sandbox ?? {}) as NonNullable<Project['sandbox']> & { statusError?: unknown };
    const pendingSandboxCleanup = project.pendingSandboxCleanup?.map(value => {
      const { status: _cleanupStatus, statusError: _cleanupError, ...metadata } = value as typeof value & { statusError?: unknown };
      return metadata as NonNullable<Project['sandbox']>;
    });
    return { ...project, ...(project.sandbox ? { sandbox: sandbox as NonNullable<Project['sandbox']> } : {}), pendingSandboxCleanup };
  }
  private sessionMergeShape(session: Session): Session {
    const { turns: _turns, sandbox: _sandbox, imageSelection: _imageSelection, historyNextCursor: _cursor, historyError: _historyError, ...metadata } = session;
    const context = session.contextUsage;
    return { ...metadata, ...(context ? { contextUsage: {
      inputTokens: context.inputTokens, cachedInputTokens: context.cachedInputTokens, outputTokens: context.outputTokens,
      model: context.model, observedAt: context.observedAt, source: context.source,
    } } : {}) } as Session;
  }
  private async upsertMainTurn(executor: Pick<Pool, 'query'>, sessionId: string, turn: Turn) {
    const values = mainTurnValues(sessionId, turn);
    await executor.query(`INSERT INTO session_turns (id,session_id,target_turn_id,type,input_text,images_json,delivery_status,native_turn_id,codex_accepted,turn_status,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,sdk_input_tokens,sdk_cached_input_tokens,sdk_cache_write_input_tokens,sdk_output_tokens,sdk_reasoning_output_tokens,started_at,completed_at,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE input_text=IF(input_text='',VALUES(input_text),input_text),images_json=IF(JSON_LENGTH(images_json)=0,VALUES(images_json),images_json),native_turn_id=COALESCE(VALUES(native_turn_id),native_turn_id),codex_accepted=GREATEST(codex_accepted,VALUES(codex_accepted)),delivery_status=CASE WHEN VALUES(codex_accepted)=1 THEN 'accepted' WHEN VALUES(turn_status) IN ('failed','cancelled') AND delivery_status='queued' THEN 'failed' ELSE delivery_status END,turn_status=CASE WHEN turn_status IN ('completed','failed','cancelled') AND VALUES(turn_status)='running' THEN turn_status ELSE VALUES(turn_status) END,input_tokens=COALESCE(VALUES(input_tokens),input_tokens),cached_input_tokens=COALESCE(VALUES(cached_input_tokens),cached_input_tokens),cache_write_input_tokens=COALESCE(VALUES(cache_write_input_tokens),cache_write_input_tokens),output_tokens=COALESCE(VALUES(output_tokens),output_tokens),reasoning_output_tokens=COALESCE(VALUES(reasoning_output_tokens),reasoning_output_tokens),sdk_input_tokens=COALESCE(VALUES(sdk_input_tokens),sdk_input_tokens),sdk_cached_input_tokens=COALESCE(VALUES(sdk_cached_input_tokens),sdk_cached_input_tokens),sdk_cache_write_input_tokens=COALESCE(VALUES(sdk_cache_write_input_tokens),sdk_cache_write_input_tokens),sdk_output_tokens=COALESCE(VALUES(sdk_output_tokens),sdk_output_tokens),sdk_reasoning_output_tokens=COALESCE(VALUES(sdk_reasoning_output_tokens),sdk_reasoning_output_tokens),started_at=VALUES(started_at),completed_at=COALESCE(VALUES(completed_at),completed_at),error=COALESCE(VALUES(error),error)`, values);
  }
  private async upsertInputRequest(executor: Pick<Pool, 'query'>, request: InputRequestRecord) {
    const values = requestTurnValues(request);
    await executor.query(`INSERT INTO session_turns (id,session_id,target_turn_id,type,method,params_json,thread_request_json,input_text,images_json,delivery_status,native_turn_id,question_request_id,request_error,started_at,sent_at,accepted_at,codex_accepted,turn_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,FALSE,'running') ON DUPLICATE KEY UPDATE session_id=IF(session_id=VALUES(session_id),session_id,NULL),target_turn_id=VALUES(target_turn_id),type=VALUES(type),method=COALESCE(VALUES(method),method),params_json=COALESCE(VALUES(params_json),params_json),thread_request_json=COALESCE(VALUES(thread_request_json),thread_request_json),input_text=COALESCE(VALUES(input_text),input_text),images_json=COALESCE(VALUES(images_json),images_json),delivery_status=CASE WHEN delivery_status='accepted' OR VALUES(delivery_status)='accepted' THEN 'accepted' WHEN delivery_status='unknown' AND VALUES(delivery_status) IN ('queued','sending') THEN 'unknown' WHEN delivery_status='failed' AND VALUES(delivery_status)='queued' THEN 'failed' WHEN delivery_status='sending' AND VALUES(delivery_status)='queued' THEN 'sending' ELSE VALUES(delivery_status) END,native_turn_id=COALESCE(VALUES(native_turn_id),native_turn_id),codex_accepted=IF(VALUES(delivery_status)='accepted' AND VALUES(id)=VALUES(target_turn_id),TRUE,codex_accepted),question_request_id=COALESCE(VALUES(question_request_id),question_request_id),request_error=COALESCE(VALUES(request_error),request_error),sent_at=COALESCE(VALUES(sent_at),sent_at),accepted_at=COALESCE(VALUES(accepted_at),accepted_at)`, values);
  }
  private mysqlDate(value: string | null | undefined): string | null { return date(value); }
}

export function createWebStateStore(mysqlUrl?: string) {
  return new MySqlWebStateStore(requireMySqlUrl(mysqlUrl));
}
