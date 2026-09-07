import type { ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface RetryState {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  nextRetryAt: string;
  status: 'waiting' | 'retrying';
}
export type AgentEvent = ThreadEvent | { type: 'runtime.retry'; retry: RetryState | null };
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
  phase?: 'starting' | 'running' | 'finalizing';
  items: ThreadItem[];
  usage?: Usage;
  error?: string;
  startedAt: string;
  completedAt?: string;
  retry?: RetryState;
}
export interface Project {
  id: string;
  name: string;
  requirementUrl: string | null;
  executionMode: 'e2b' | 'local';
  workingDirectory: string;
  sandbox?: Session['sandbox'];
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
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
  sandbox?: { id: string; status: 'starting' | 'ready' | 'paused' | 'unavailable'; template: string; workingDirectory: string };
}
export type SessionSummary = Omit<Session, 'turns'> & { turnCount: number };
export interface SandboxRecord {
  project?: { id: string; name: string; requirementUrl: string | null; sessionCount: number } | null;
  sessions?: Array<{ id: string; title: string; status: SessionStatus }>;
  id: string;
  template: string;
  state: 'running' | 'paused' | 'unknown';
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
  capabilities: { interactiveApprovals: false; tokenDeltas: false };
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
