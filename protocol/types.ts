import type { ProjectImageSelection } from './image-types.js';
import type { SandboxImageIdentity, SandboxState } from './sandbox-types.js';
import type { ThreadEvent, ThreadItem, Usage } from './agent-protocol.js';
import type { UserInputRequest } from './user-input-types.js';
import type { InputRequestType } from './input-request-types.js';

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface RetryState {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  nextRetryAt: string;
  status: 'waiting' | 'retrying';
}
export interface BlockEstimate {
  id: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  turnId?: string;
  itemId?: string;
}

/** Actual input size of the most recent model request, as reported by Responses. */
export interface ContextUsage {
  segment?: number;
  outputItemIds?: string[];
  /** Transient native-reader input; removed before returning/persisting estimates. */
  blockTexts?: Array<{ id: string; label: string; text: string; turnId?: string; direction: 'input' | 'output' }>;
  /** Local text tokenizer estimates; not provider-attributed message usage. */
  blockEstimates?: BlockEstimate[];
  blockTokenizer?: string;
  requestId?: string;
  responseId?: string;
  requestIds?: Record<string, string>;
  requestAttempt?: number;
  source?: 'responses' | 'rollout';
  /** Numeric token counters retained from the provider for later recalculation. */
  rawUsage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: Record<string, number>;
    output_tokens_details?: Record<string, number>;
  };
  model?: string;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  observedAt: string;
}
export type AgentEvent = ThreadEvent
  | { type: 'runtime.retry'; retry: RetryState | null }
  | { type: 'runtime.context_usage'; contextUsage: ContextUsage };
export interface Settings {
  executionMode?: 'local' | 'sandbox';
  workingDirectory: string;
  model: string;
  /** Stable channel-model identity; absent on legacy sessions. */
  modelEntryId?: string;
  modelReasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';
  collaborationMode?: 'default' | 'plan';
  fastMode?: boolean;
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  webSearchMode: 'disabled' | 'cached' | 'live';
  networkAccessEnabled: boolean;
}
/** POST /api/sessions/:id/turns: starts a turn, or steers the running turn
 * with text-only input. An accepted steer returns that existing turn's ID.
 * An uncertain RPC outcome must not be automatically resubmitted. */
export interface SubmitTurnResponse { turnId: string }
export interface CompactionSelector { itemId?: string; segment?: number }
/** GET /api/sessions/:id/compaction; an optional threadId must belong to this session's agent tree. */
export interface CompactionContent { itemId?: string; segment: number; timestamp: string; summary: string | null }
export interface Turn {
  /** Kind of the submission that started this native execution. */
  type?: InputRequestType;
  segment?: number;
  compactions?: Array<{ segment: number; timestamp: string; beforeItemIndex: number; itemId?: string; summary?: string | null }>;
  nativeTurnId?: string;
  /** User messages injected into an accepted native turn after its original prompt. */
  additionalUserInputs?: string[];
  /** Presentation boundaries from native history or live acceptance, aligned with additionalUserInputs. */
  additionalUserInputPositions?: Array<{ beforeItemIndex: number; itemId?: string }>;
  /** Native identity of the initial user message, used to reconcile live input events. */
  userInputItemId?: string;
  /** Confirmed by the App Server turn.started event, not by saving a web submission. */
  codexAccepted?: boolean;
  /** Browser-only failure observed by the currently open page. Never persisted. */
  clientFailure?: true;
  id: string;
  prompt: string;
  images: string[];
  status: SessionStatus;
  phase?: 'starting' | 'recovering' | 'running' | 'finalizing';
  items: ThreadItem[];
  usage?: Usage;
  /** Native turn usage before normalization to per-request token totals. */
  sdkUsage?: Usage;
  error?: string;
  startedAt: string;
  completedAt?: string;
  /** Timestamp for each streamed item, keyed by item id. */
  itemTimestamps?: Record<string, string>;
  /** One entry for each completed model request in this turn. */
  contextUsage?: ContextUsage[];
  retry?: RetryState;
  userInputRequests?: UserInputRequest[];
}
export type ProjectStatus = 'active' | 'completed' | 'archived' | 'deleting';
export interface ProjectSandboxOperation {
  /** Local request identifier for observation; never used for remote replay. */
  id?: string;
  /** Legacy ownership metadata retained for reading old records only. */
  resume?: { sandboxId: string; ownerId: string };
  /** Operation outcome, including a released Box; independent of current Box observations. */
  result?: { sandbox: SandboxState };
  /** Image selected by this restore request; no resource reservation. */
  imageSelection?: ProjectImageSelection;
  /** Checkpoint only pauses the Sandbox; workspace backup is a separate explicit operation. */
  kind: 'create' | 'checkpoint' | 'backup' | 'restore' | 'archive' | 'refresh' | 'resume' | 'rebuild' | 'release' | 'delete';
  /** Native operation/resource identities, for inspection only; never replayed. */
  remoteOperationId?: string;
  volumeId?: string;
  candidateVolumeId?: string;
  phase: string;
  status: 'running' | 'failed' | 'succeeded' | 'unknown';
  error?: string;
  errorCode?: string;
  /** Archive is durable; reclaiming the old runtime or cache can be retried independently. */
  cleanupError?: string;
  retentionError?: string;
  catalogError?: string;
  sizeBytes?: number;
  durationMs?: number;
  scannedBytes?: number;
  addedBytes?: number;
  repositorySizeBytes?: number;
  snapshotId?: string;
  verified?: boolean;
  updatedAt: string;
}
/** 1: ordinary, 2: Feishu requirement, 3: weekly project. */
export type ProjectType = 1 | 2 | 3;

export interface ProjectSandboxBackup {
  id: string;
  sandboxId?: string;
  volumeId?: string;
  remoteOperationId?: string;
  /** Snapshots present before a deletion backup was submitted, for lost-response reconciliation. */
  captureBaseline?: string[];
  snapshotId?: string;
  retentionError?: string;
  catalogError?: string;
  sizeBytes?: number;
  addedBytes?: number;
  status: 'running' | 'failed' | 'succeeded' | 'unknown';
  phase: string;
  error?: string;
  durationMs?: number;
  scannedBytes?: number;
  verified?: boolean;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  /** Missing values are legacy ordinary projects. */
  type?: ProjectType;
  /** Monday in Asia/Shanghai for type 3 projects. */
  weekOf?: string;
  requirementUrl: string | null;
  /** Current status of the linked Feishu (Meegle) work item, when available. */
  requirementStatus?: string | null;
  executionMode: 'sandbox' | 'local';
  workingDirectory: string;
  /** `archivedAt` is retained for legacy records and archive grouping. */
  status?: ProjectStatus;
  /** Removed from project lists; the backup/recovery index remains available. */
  removedAt?: string;
  completedAt?: string | null;
  imageSelection?: ProjectImageSelection;
  sandbox?: SandboxState;
  /** Retained mounts survive releasing the project's current Box. */
  sandboxMounts?: import('./sandbox-types.js').SandboxMount[];
  /** Cellbox ownership namespace of the retained mounts, including restored volumes. */
  sandboxOwnerKey?: string;
  /** Timestamp at which archiving released the project's Sandbox binding. */
  sandboxReclaimedAt?: string;
  /** Confirmed runtime and Cellbox artifact cleanup; absent on legacy archives awaiting reconciliation. */
  sandboxArtifactsCleanedAt?: string;
	/** Product references only; archive bytes and integrity belong to the box service. */
	remoteArchives?: import('./remote-archive-types.js').RemoteArchiveRef[];
  latestBackup?: LatestBackupSummary;
  sandboxOperation?: ProjectSandboxOperation;
  /** Result of an explicit workspace backup, independent of checkpoint outcome. */
  sandboxBackup?: ProjectSandboxBackup;
  /** Uncommitted replacement containers and retired containers awaiting cleanup. */
  pendingSandboxCleanup?: SandboxState[];
  /** Restored disks whose Sandbox creation/binding has not completed. */
  pendingVolumeCleanup?: string[];
  /** Verified archive source awaiting cleanup; survives retries/restarts after archiving. */
  archiveCleanupSourceId?: string;
  archivedAt?: string | null;
  lifecycleHistory?: ProjectLifecycleRecord[];
  createdAt: string;
  updatedAt: string;
}
export interface ProjectLifecycleRecord {
  id: string;
  action: 'completed' | 'archived' | 'restored' | 'released';
  at: string;
  sandboxId?: string;
}
export interface LatestBackupSummary {
  createdAt: string;
  sizeBytes?: number;
  checksum?: string;
}

export interface ArchiveVersionSummary {
  id: string;
  version: number;
  createdAt: string;
  sizeBytes?: number;
  bytesAdded?: number;
  browsable?: boolean;
  storageType?: 'cellbox' | 'oss' | 'cellbox-volume';
  label: string;
}

/** Project Sandbox mutation requests wait for durable completion. Creation returns
 * 201, other operations return 200 with a terminal result, or a request error.
 * Running operations may still be observed through read-only queries after a disconnect. */
export interface ProjectSummary extends Project { sessionCount: number; activeSessionId: string | null;
  backupPolicy?: import('./remote-archive-types.js').VolumeBackupPolicy;
  backupPolicyError?: string;
  /** Cellbox archive versions, newest first. */
  archiveVersions?: ArchiveVersionSummary[];
}

export const PROJECT_OPERATION_WAIT_MS = 10_000;

/** GET /api/projects/:id remains read-only and queries storage on every request.
 * Optional query parameters poll storage until the durable operation finishes
 * (success or failure), then return its latest
 * persisted view. An operation replaced before completion returns the current
 * view; a timeout returns the current view. Disconnecting cancels only this wait. */
export interface ProjectReadOptions {
  waitForOperation?: string;
  /** Integer milliseconds, 0 through PROJECT_OPERATION_WAIT_MS; default 10s. */
  waitMs?: number;
}
export interface Session {
  projectId?: string;
  id: string;
  threadId: string | null;
  /** Verified relative location of the Codex rollout, refreshed when it moves. */
  nativeHistoryPath?: string;
  /** Transient history refresh failure; the saved transcript remains available. */
  historyError?: string;
  title: string;
  settings: Settings;
  status: SessionStatus;
  /** When the session was created. Kept separately from updates to support archive history. */
  startedAt: string;
  /** Null while the session remains active; set when it is moved to the archive. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
  /** Cursor for older App Server turns in a session-detail response. Never persisted. */
  historyNextCursor?: string | null;
  /** Total accepted turns when only a page of conversation is loaded. */
  turnCount?: number;
  /** Most recently observed model context length. */
  contextUsage?: ContextUsage;
  imageSelection?: ProjectImageSelection;
  sandbox?: SandboxState;
}
export type SessionSummary = Omit<Session, 'turns'> & { turnCount: number };
export interface SessionTurnPage { turns: Turn[]; nextCursor: string | null }
export interface SubagentConversation {
  threadId: string;
  parentThreadId: string;
  path: string;
  nickname?: string;
  depth: number;
  startedAt: string;
  turns: Turn[];
}
export interface SandboxRecord {
  /** Platform-created sandbox without a current binding or in-flight reservation. */
  dangling?: boolean;
  project?: { id: string; name: string; requirementUrl: string | null; sessionCount: number } | null;
  sessions?: Array<{ id: string; title: string; status: SessionStatus }>;
  id: string;
  template: string;
  image?: SandboxImageIdentity;
  state: 'running' | 'paused' | 'unknown';
  /** Lifecycle phase returned by the inventory source. */
  phase?: string;
  inventorySource?: 'kubernetes' | 'node';
  pausedAt?: string;
  cpuCount: number;
  memoryMB: number;
  startedAt: string;
  endAt: string;
  session: { id: string; title: string; status: SessionStatus } | null;
  metrics: {
    timestamp: string;
    cpuUsedPct: number;
    memUsedBytes: number;
    memTotalBytes: number;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
  } | null;
  metricsStatus: 'available' | 'paused' | 'unavailable' | 'pending';
  metricsSource?: 'cellbox';
  metricsMessage?: string;
}
export interface SandboxInventory {
  enabled: boolean;
  fetchedAt: string;
  sandboxes: SandboxRecord[];
}
export interface AppConfig {
  modelOptions?: import('./model-types.js').ModelOption[];
  /** Models discovered from the configured upstream, when available. */
  models?: string[];
  localWorkingDirectory?: string;
  sandbox?: {
    provider?: 'cellbox';
    kind?: 'k8s-resumable';
    enabled: boolean;
    image: string;
    imageIdentity?: SandboxImageIdentity;
    workingDirectory: string;
    archivedReclaimAfterMs?: number;
  };
  defaults: Settings;
  codexVersion: string;
  auth: 'api-key' | 'local-codex';
  approvalPolicy: 'never';
  capabilities: { interactiveApprovals: false; tokenDeltas: false; sandboxPreviews?: boolean; nativeWebSocket?: boolean };
}
export type StreamMessage =
  | { type: 'snapshot'; session: Session }
  | { type: 'sdk'; turnId: string; event: AgentEvent }
  | { type: 'state'; session: Session };


/** Provider failures keep their classification; an unreadable accepted mutation is still an API error. */
export interface ApiErrorResponse {
  error: string | { message?: string; code?: string };
  code?: string;
  /** Original upstream success status when CoCell cannot confirm the mutation result. */
  upstreamStatus?: number;
}
