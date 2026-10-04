import type { ProjectImageSelection } from './image-types.js';
import type { SandboxImageIdentity, SandboxState } from './sandbox-types.js';
import type { ThreadEvent, ThreadItem, Usage } from './agent-protocol.js';
import type { UserInputRequest } from './user-input-types.js';

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
  modelReasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  webSearchMode: 'disabled' | 'cached' | 'live';
  networkAccessEnabled: boolean;
}
export interface Turn {
  segment?: number;
  compactions?: Array<{ segment: number; timestamp: string; beforeItemIndex: number }>;
  nativeTurnId?: string;
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
export type ProjectStatus = 'active' | 'completed' | 'archived';
export interface ProjectSandboxOperation {
  /** Resume completion confirms runtime restoration; health diagnostics do not gate it. */
	/** Persisted intention ID used for remote operation idempotency. */
	id?: string;
  kind: 'create' | 'checkpoint' | 'backup' | 'restore' | 'archive' | 'refresh' | 'resume';
  phase: string;
  status: 'running' | 'failed' | 'succeeded';
  error?: string;
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
  completedAt?: string | null;
  imageSelection?: ProjectImageSelection;
  sandbox?: SandboxState;
  /** Timestamp at which project archiving removed the previous sandbox. */
  sandboxReclaimedAt?: string;
	/** Product references only; archive bytes and integrity belong to the box service. */
	remoteArchives?: import('./remote-archive-types.js').RemoteArchiveRef[];
  backupRetentionCount?: number;
  latestBackup?: LatestBackupSummary;
  sandboxOperation?: ProjectSandboxOperation;
  /** Uncommitted replacement containers and retired containers awaiting cleanup. */
  pendingSandboxCleanup?: SandboxState[];
  archivedAt?: string | null;
  lifecycleHistory?: ProjectLifecycleRecord[];
  createdAt: string;
  updatedAt: string;
}
export interface ProjectLifecycleRecord {
  id: string;
  action: 'completed' | 'archived' | 'restored';
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
  sizeBytes: number;
  bytesAdded?: number;
  label: string;
}

export interface ProjectSummary extends Project { sessionCount: number; activeSessionId: string | null;
  /** Cellbox archive versions, newest first. */
  archiveVersions?: ArchiveVersionSummary[];
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
  inventorySource?: 'kubernetes' | 'oss';
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
  capabilities: { interactiveApprovals: false; tokenDeltas: false; sandboxPreviews?: boolean };
}
export type StreamMessage =
  | { type: 'snapshot'; session: Session }
  | { type: 'sdk'; turnId: string; event: AgentEvent }
  | { type: 'state'; session: Session };
