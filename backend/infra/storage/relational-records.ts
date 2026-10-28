import type { Project, Session, Turn } from '../../../protocol/types.js';
import type { InputRequestRecord } from '../../../protocol/input-request-types.js';
import type { SandboxMount, SandboxState } from '../../../protocol/sandbox-types.js';
import type { RowDataPacket } from 'mysql2/promise';

export type DbRow = RowDataPacket & Record<string, unknown>;
export const json = (value: unknown): string | null => value === undefined ? null : JSON.stringify(value);
export function fromJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}
export const date = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid timestamp in web state: ${value}`);
  return parsed.toISOString().slice(0, 23).replace('T', ' ');
};
export const iso = (value: unknown): string | null => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
};

function sandboxColumns(project: Project) {
  const sandbox = project.sandbox;
  const mounts = project.sandboxMounts ?? sandbox?.mounts ?? [];
  const image = sandbox?.image;
  return [sandbox?.id ?? null, sandbox?.ownerKey ?? project.sandboxOwnerKey ?? null,
    sandbox?.template ?? null, sandbox?.workingDirectory ?? null, json(mounts),
    image?.reference ?? null, image?.id ?? null, json(image?.repoDigests), image?.version ?? null,
    image?.templateId ?? null, image?.revisionId ?? null, sandbox?.homeVolumeId ?? null,
    date(sandbox?.lastActiveAt), date(sandbox?.pausedAt), date(project.sandboxReclaimedAt),
    date(project.sandboxArtifactsCleanedAt)];
}
export const PROJECT_COLUMNS = `id,name,type,week_of,requirement_url,requirement_status,execution_mode,working_directory,status,
 current_box_id,sandbox_owner_key,sandbox_template,sandbox_working_directory,mounts_json,sandbox_image_reference,sandbox_image_id,
 sandbox_image_repo_digests_json,sandbox_image_version,sandbox_image_template_id,sandbox_image_revision_id,home_volume_id,
 sandbox_last_active_at,sandbox_paused_at,sandbox_reclaimed_at,sandbox_artifacts_cleaned_at,image_catalog_id,image_name,image_category,image_version_id,image_version,
 template_id,revision_id,image_reference,image_migration_required,
 sandbox_operation_json,sandbox_backup_json,latest_backup_json,remote_archives_json,pending_sandbox_cleanup_json,
 pending_volume_cleanup_json,archive_cleanup_source_id,lifecycle_history_json,removed_at,completed_at,archived_at,created_at,updated_at`;
export function projectValues(project: Project): unknown[] {
  // image_version_id retains the selector; revision_id stores its concrete resolved revision.
  return [project.id, project.name, project.type ?? 1, project.weekOf ?? null, project.requirementUrl,
    project.requirementStatus ?? null, project.executionMode, project.workingDirectory,
    project.status ?? (project.archivedAt ? 'archived' : project.completedAt ? 'completed' : 'active'),
    ...sandboxColumns(project), project.imageSelection?.imageId ?? null, project.imageSelection?.imageName ?? null,
    project.imageSelection?.category ?? null,
    project.imageSelection?.selectionPolicy === 'latest' ? 'latest' : project.imageSelection?.versionId ?? null,
    project.imageSelection?.version ?? null, project.imageSelection?.templateId ?? null,
    project.imageSelection?.revisionId ?? null, project.imageSelection?.image ?? null, project.imageSelection?.migrationRequired ? 1 : 0,
    json(project.sandboxOperation), json(project.sandboxBackup),
    json(project.latestBackup), json(project.remoteArchives), json((project.pendingSandboxCleanup ?? []).map(s => ({
      id: s.id, ownerKey: s.ownerKey, mounts: s.mounts, homeVolumeId: s.homeVolumeId, phase: s.phase,
      generation: s.generation, operationId: s.operationId, lastActiveAt: s.lastActiveAt, pausedAt: s.pausedAt,
      template: s.template, image: s.image, workingDirectory: s.workingDirectory,
    }))), json(project.pendingVolumeCleanup), project.archiveCleanupSourceId ?? null, json(project.lifecycleHistory),
    date(project.removedAt), date(project.completedAt), date(project.archivedAt), date(project.createdAt), date(project.updatedAt)];
}
export function projectFromRow(row: Record<string, unknown>): Project {
  const mounts = fromJson<SandboxMount[]>(row.mounts_json, []);
  const boxId = row.current_box_id ? String(row.current_box_id) : undefined;
  const sandbox: SandboxState | undefined = boxId ? {
    id: boxId, ownerKey: row.sandbox_owner_key ? String(row.sandbox_owner_key) : undefined,
    template: String(row.sandbox_template ?? ''), workingDirectory: String(row.sandbox_working_directory ?? row.working_directory ?? ''),
    mounts, homeVolumeId: row.home_volume_id ? String(row.home_volume_id) : undefined,
    lastActiveAt: iso(row.sandbox_last_active_at) ?? undefined, pausedAt: iso(row.sandbox_paused_at) ?? undefined,
    status: 'unknown',
    ...(row.sandbox_image_id ? { image: {
      reference: String(row.sandbox_image_reference ?? ''), id: String(row.sandbox_image_id),
      repoDigests: fromJson<string[]>(row.sandbox_image_repo_digests_json, []),
      ...(row.sandbox_image_version ? { version: String(row.sandbox_image_version) } : {}),
      ...(row.sandbox_image_template_id ? { templateId: String(row.sandbox_image_template_id) } : {}),
      ...(row.sandbox_image_revision_id ? { revisionId: String(row.sandbox_image_revision_id) } : {}),
    } } : {}),
  } : undefined;
  const archivedAt = iso(row.archived_at);
  return {
    id: String(row.id), name: String(row.name), type: Number(row.type) as Project['type'],
    ...(row.week_of ? { weekOf: row.week_of instanceof Date ? row.week_of.toISOString().slice(0, 10) : String(row.week_of).slice(0, 10) } : {}),
    requirementUrl: row.requirement_url == null ? null : String(row.requirement_url),
    requirementStatus: row.requirement_status == null ? null : String(row.requirement_status),
    executionMode: String(row.execution_mode) as Project['executionMode'], workingDirectory: String(row.working_directory),
    status: String(row.status) as Project['status'], ...(iso(row.removed_at) ? { removedAt: iso(row.removed_at)! } : {}),
    completedAt: iso(row.completed_at), archivedAt,
    ...(row.image_catalog_id ? { imageSelection: { imageId: String(row.image_catalog_id), imageName: String(row.image_name ?? ''),
      ...(row.image_version_id === 'latest' ? { selectionPolicy: 'latest' as const } : {}),
      category: String(row.image_category ?? ''),
      versionId: String(row.image_version_id === 'latest' ? row.revision_id ?? 'latest' : row.image_version_id ?? ''),
      version: String(row.image_version ?? ''),
      ...(row.template_id ? { templateId: String(row.template_id) } : {}), ...(row.revision_id ? { revisionId: String(row.revision_id) } : {}),
      image: String(row.image_reference ?? ''), ...(row.image_migration_required ? { migrationRequired: true } : {}) } } : {}),
    ...(sandbox ? { sandbox } : {}), sandboxMounts: mounts,
    ...(row.sandbox_owner_key ? { sandboxOwnerKey: String(row.sandbox_owner_key) } : {}),
    ...(iso(row.sandbox_reclaimed_at) ? { sandboxReclaimedAt: iso(row.sandbox_reclaimed_at)! } : {}),
    ...(iso(row.sandbox_artifacts_cleaned_at) ? { sandboxArtifactsCleanedAt: iso(row.sandbox_artifacts_cleaned_at)! } : {}),
    ...(fromJson<Project['sandboxOperation']>(row.sandbox_operation_json, undefined) ? { sandboxOperation: fromJson(row.sandbox_operation_json, undefined) } : {}),
    ...(fromJson<Project['sandboxBackup']>(row.sandbox_backup_json, undefined) ? { sandboxBackup: fromJson(row.sandbox_backup_json, undefined) } : {}),
    ...(fromJson<Project['latestBackup']>(row.latest_backup_json, undefined) ? { latestBackup: fromJson(row.latest_backup_json, undefined) } : {}),
    ...(fromJson<Project['remoteArchives']>(row.remote_archives_json, undefined) ? { remoteArchives: fromJson(row.remote_archives_json, undefined) } : {}),
    pendingSandboxCleanup: fromJson(row.pending_sandbox_cleanup_json, []), pendingVolumeCleanup: fromJson(row.pending_volume_cleanup_json, []),
    ...(row.archive_cleanup_source_id ? { archiveCleanupSourceId: String(row.archive_cleanup_source_id) } : {}),
    lifecycleHistory: fromJson(row.lifecycle_history_json, []),
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
  };
}

export const SESSION_COLUMNS = `id,project_id,thread_id,native_history_path,title,execution_mode,working_directory,model,model_entry_id,
 model_reasoning_effort,collaboration_mode,fast_mode,sandbox_mode,web_search_mode,network_access_enabled,status,turn_count,context_input_tokens,
 context_cached_input_tokens,context_output_tokens,context_model,context_observed_at,context_source,archived_at,started_at,created_at,updated_at`;
export function sessionValues(session: Session): unknown[] {
  const usage = session.contextUsage;
  return [session.id, session.projectId ?? null, session.threadId, session.nativeHistoryPath ?? null, session.title,
    session.settings.executionMode ?? 'local', session.settings.workingDirectory, session.settings.model,
    session.settings.modelEntryId ?? null, session.settings.modelReasoningEffort,
    session.settings.collaborationMode ?? 'default', session.settings.fastMode ? 1 : 0, session.settings.sandboxMode,
    session.settings.webSearchMode, session.settings.networkAccessEnabled ? 1 : 0, session.status,
    session.turnCount ?? session.turns.filter(t => t.codexAccepted || t.nativeTurnId).length,
    usage?.inputTokens ?? null, usage?.cachedInputTokens ?? null, usage?.outputTokens ?? null, usage?.model ?? null,
    date(usage?.observedAt), usage?.source ?? null, date(session.archivedAt), date(session.startedAt),
    date(session.createdAt), date(session.updatedAt)];
}
export function sessionFromRow(row: Record<string, unknown>): Session {
  const executionMode = String(row.execution_mode) as NonNullable<Session['settings']['executionMode']>;
  const session: Session = {
    id: String(row.id), projectId: row.project_id == null ? undefined : String(row.project_id),
    threadId: row.thread_id == null ? null : String(row.thread_id),
    ...(row.native_history_path ? { nativeHistoryPath: String(row.native_history_path) } : {}), title: String(row.title),
    settings: { executionMode, workingDirectory: String(row.working_directory), model: String(row.model),
      ...(row.model_entry_id ? { modelEntryId: String(row.model_entry_id) } : {}),
      modelReasoningEffort: String(row.model_reasoning_effort) as Session['settings']['modelReasoningEffort'],
      collaborationMode: row.collaboration_mode === 'plan' ? 'plan' : 'default', fastMode: Boolean(row.fast_mode),
      sandboxMode: String(row.sandbox_mode) as Session['settings']['sandboxMode'],
      webSearchMode: String(row.web_search_mode) as Session['settings']['webSearchMode'], networkAccessEnabled: Boolean(row.network_access_enabled) },
    status: String(row.status) as Session['status'], startedAt: iso(row.started_at)!, archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, turns: [], turnCount: Number(row.turn_count ?? 0),
  };
  if (row.context_input_tokens != null && row.context_observed_at != null) session.contextUsage = {
    inputTokens: Number(row.context_input_tokens), ...(row.context_cached_input_tokens == null ? {} : { cachedInputTokens: Number(row.context_cached_input_tokens) }),
    ...(row.context_output_tokens == null ? {} : { outputTokens: Number(row.context_output_tokens) }),
    ...(row.context_model ? { model: String(row.context_model) } : {}), observedAt: iso(row.context_observed_at)!,
    ...(row.context_source === 'responses' || row.context_source === 'rollout' ? { source: row.context_source } : {}),
  };
  return session;
}

export interface SessionTurnRow extends Record<string, unknown> {
  id: string; session_id: string; target_turn_id: string; type: string; input_text: string; images_json: unknown;
  method?: string | null; question_request_id?: string | null; request_error?: string | null; sent_at?: unknown; accepted_at?: unknown;
  params_json: unknown; thread_request_json: unknown; delivery_status: string; native_turn_id: string | null;
  codex_accepted: number | boolean; turn_status: string;
  input_tokens?: number | string | null; cached_input_tokens?: number | string | null; cache_write_input_tokens?: number | string | null;
  output_tokens?: number | string | null; reasoning_output_tokens?: number | string | null;
  sdk_input_tokens?: number | string | null; sdk_cached_input_tokens?: number | string | null;
  sdk_cache_write_input_tokens?: number | string | null; sdk_output_tokens?: number | string | null; sdk_reasoning_output_tokens?: number | string | null;
  started_at: unknown; completed_at: unknown; error: string | null;
}
export function inputRequestFromRow(row: SessionTurnRow): InputRequestRecord {
  return { id: row.id, sessionId: row.session_id, turnId: row.target_turn_id,
    type: row.type as InputRequestRecord['type'], input: row.input_text,
    ...(row.method ? { method: row.method as InputRequestRecord['method'] } : {}),
    ...(row.question_request_id ? { requestId: row.question_request_id } : {}),
    ...(fromJson(row.params_json, undefined) ? { params: fromJson(row.params_json, undefined) } : {}),
    ...(fromJson(row.thread_request_json, undefined) ? { threadRequest: fromJson(row.thread_request_json, undefined) } : {}),
    ...(fromJson<string[]>(row.images_json, []).length ? { images: fromJson<string[]>(row.images_json, []) } : {}),
    status: row.delivery_status as InputRequestRecord['status'],
    ...(row.native_turn_id ? { nativeTurnId: row.native_turn_id } : {}),
    ...(row.request_error ? { error: row.request_error } : {}), createdAt: iso(row.started_at)!,
    ...(iso(row.sent_at) ? { sentAt: iso(row.sent_at)! } : {}), ...(iso(row.accepted_at) ? { acceptedAt: iso(row.accepted_at)! } : {}) };
}
export function turnFromRow(row: SessionTurnRow): Turn {
  const usageColumns = [row.input_tokens, row.cached_input_tokens, row.cache_write_input_tokens, row.output_tokens, row.reasoning_output_tokens];
  const usage = usageColumns.every(value => value !== null && value !== undefined) ? { input_tokens: Number(row.input_tokens),
    cached_input_tokens: Number(row.cached_input_tokens), cache_write_input_tokens: Number(row.cache_write_input_tokens),
    output_tokens: Number(row.output_tokens), reasoning_output_tokens: Number(row.reasoning_output_tokens) } : undefined;
  const sdkUsageColumns = [row.sdk_input_tokens, row.sdk_cached_input_tokens, row.sdk_cache_write_input_tokens,
    row.sdk_output_tokens, row.sdk_reasoning_output_tokens];
  const sdkUsage = sdkUsageColumns.every(value => value !== null && value !== undefined) ? {
    input_tokens: Number(row.sdk_input_tokens), cached_input_tokens: Number(row.sdk_cached_input_tokens),
    cache_write_input_tokens: Number(row.sdk_cache_write_input_tokens), output_tokens: Number(row.sdk_output_tokens),
    reasoning_output_tokens: Number(row.sdk_reasoning_output_tokens),
  } : undefined;
  return { id: row.target_turn_id, prompt: row.input_text, images: fromJson(row.images_json, []),
    ...(['message', 'steer', 'question_reply'].includes(row.type) ? { type: row.type as Turn['type'] } : {}),
    status: row.turn_status as Turn['status'], ...(row.native_turn_id ? { nativeTurnId: row.native_turn_id } : {}),
    codexAccepted: Boolean(row.codex_accepted), items: [], ...(usage ? { usage } : {}),
    ...(sdkUsage ? { sdkUsage } : {}),
    ...(row.error ? { error: row.error } : {}), startedAt: iso(row.started_at)!, ...(iso(row.completed_at) ? { completedAt: iso(row.completed_at)! } : {}),
  };
}
export function requestTurnValues(request: InputRequestRecord) {
  return [request.id, request.sessionId, request.turnId, request.type, request.method ?? null, json(request.params),
    json(request.threadRequest), request.input, json(request.images ?? []), request.status, request.nativeTurnId ?? null,
    request.requestId ?? null, request.error ?? null, date(request.createdAt), date(request.sentAt), date(request.acceptedAt)];
}
export function mainTurnValues(sessionId: string, turn: Turn) {
  const accepted = !!turn.codexAccepted || !!turn.nativeTurnId;
  return [turn.id, sessionId, turn.id, turn.type ?? 'message', turn.prompt, json(turn.images),
    accepted ? 'accepted' : turn.status === 'failed' || turn.status === 'cancelled' ? 'failed' : 'queued', turn.nativeTurnId ?? null,
    accepted ? 1 : 0, turn.status,
    turn.usage?.input_tokens ?? null, turn.usage?.cached_input_tokens ?? null, turn.usage?.cache_write_input_tokens ?? null,
    turn.usage?.output_tokens ?? null, turn.usage?.reasoning_output_tokens ?? null,
    turn.sdkUsage?.input_tokens ?? null, turn.sdkUsage?.cached_input_tokens ?? null, turn.sdkUsage?.cache_write_input_tokens ?? null,
    turn.sdkUsage?.output_tokens ?? null, turn.sdkUsage?.reasoning_output_tokens ?? null,
    date(turn.startedAt), date(turn.completedAt), turn.error ?? null];
}
