import type { SandboxState } from './sandbox-types.js';
import type { UserApproval } from './approval-types.js';
import type { ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface RetryState {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  nextRetryAt: string;
  status: 'waiting' | 'retrying';
}
/** Actual input size of the most recent model request, as reported by Responses. */
export interface ContextUsage {
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
  executionMode?: 'local' | 'e2b';
  workingDirectory: string;
  model: string;
  modelReasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  webSearchMode: 'disabled' | 'cached' | 'live';
  networkAccessEnabled: boolean;
}
export interface Turn {
  id: string;
  prompt: string;
  images: string[];
  status: SessionStatus;
  phase?: 'starting' | 'recovering' | 'running' | 'finalizing';
  items: ThreadItem[];
  usage?: Usage;
  error?: string;
  startedAt: string;
  completedAt?: string;
  /** Timestamp for each streamed SDK item, keyed by item id. */
  itemTimestamps?: Record<string, string>;
  /** One entry for each completed model request in this turn. */
  contextUsage?: ContextUsage[];
  retry?: RetryState;
  approvals?: UserApproval[];
  /** Durable reference to a Codex worker that runs inside an E2B sandbox. */
  execution?: {
    kind: 'e2b-worker';
    protocolVersion: 1;
    workerId: string;
    sandboxId?: string;
    commandPid?: number;
    lastAppliedSeq: number;
    state: 'launching' | 'running' | 'detached' | 'terminal';
  };
}
export interface Project {
  id: string;
  name: string;
  requirementUrl: string | null;
  /** Current status of the linked Feishu (Meegle) work item, when available. */
  requirementStatus?: string | null;
  executionMode: 'e2b' | 'local';
  workingDirectory: string;
  sandbox?: SandboxState;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectSummary extends Project { sessionCount: number; activeSessionId: string | null }
export interface Session {
  projectId?: string;
  id: string;
  threadId: string | null;
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
  /** Most recently observed model context length. */
  contextUsage?: ContextUsage;
  sandbox?: SandboxState;
}
export type SessionSummary = Omit<Session, 'turns'> & { turnCount: number };
export interface SandboxRecord {
  project?: { id: string; name: string; requirementUrl: string | null; sessionCount: number } | null;
  sessions?: Array<{ id: string; title: string; status: SessionStatus }>;
  id: string;
  template: string;
  state: 'running' | 'paused' | 'unknown' | 'archiving' | 'archived' | 'restoring';
  pausedAt?: string;
  archive?: SandboxState['archive'];
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
  metricsSource?: 'e2b' | 'envd';
  metricsMessage?: string;
}
export interface SandboxInventory {
  enabled: boolean;
  fetchedAt: string;
  sandboxes: SandboxRecord[];
}
export interface AppConfig {
  localWorkingDirectory?: string;
  e2b?: { enabled: boolean; template: string; workingDirectory: string };
  defaults: Settings;
  sdkVersion: string;
  auth: 'api-key' | 'local-codex';
  approvalPolicy: 'never';
  capabilities: { interactiveApprovals: false; tokenDeltas: false; sandboxPreviews?: boolean };
}
export interface GitChange { path: string; status: string }
export interface Changes { branch: string; files: GitChange[]; diff: string; error?: string }
export interface RawToolPayload {
  type: 'custom_tool_call' | 'function_call' | 'custom_tool_call_output' | 'function_call_output';
  id?: string;
  call_id?: string;
  name?: string;
  input?: string;
  arguments?: string;
  output?: unknown;
  status?: string;
}
export interface RawToolMessage {
  /** Stable byte offset of this record within the local rollout. */
  id: string;
  timestamp?: string;
  payload: RawToolPayload;
}
export interface RawToolPage {
  location?: 'local' | 'e2b';
  sandboxId?: string;
  source: 'codex-rollout';
  threadId: string | null;
  availability: 'available' | 'pending' | 'missing';
  messages: RawToolMessage[];
  nextCursor: number;
  hasMore: boolean;
  skippedLines: number;
}
export type StreamMessage =
  | { type: 'snapshot'; session: Session }
  | { type: 'sdk'; turnId: string; event: AgentEvent }
  | { type: 'state'; session: Session };
