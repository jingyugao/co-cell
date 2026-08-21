export type ProjectStatus = "active" | "closed" | "archived";
export type AgentInstanceStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "disabled"
  | "failed";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "cancelled";
export type InboxEventStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "ignored";

export interface ProjectSummary {
  id: string;
  source: string;
  externalProjectId: string;
  externalUrl: string | null;
  name: string | null;
  status: ProjectStatus;
  agentInstance: {
    id: string;
    status: AgentInstanceStatus;
    specKey: string;
  } | null;
  currentRun: {
    id: string;
    status: RunStatus;
    taskSummary: string | null;
  } | null;
  updatedAt: string;
}

export interface RunEventDto {
  sequenceNo: number;
  eventType: string;
  level: "debug" | "info" | "warning" | "error";
  title: string;
  detail: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectWorkbench {
  project: {
    id: string;
    source: string;
    externalProjectId: string;
    name: string | null;
    status: ProjectStatus;
    owner: string | null;
    updatedAt: string;
  };
  statistics: {
    activeRuns: number;
    totalRuns: number;
    completedRuns: number;
    successRate: number | null;
  };
  primaryAgentInstance: {
    id: string;
    specKey: string;
    specVersion: number;
    status: AgentInstanceStatus;
    workspaceKey: string;
    threadId: string;
    lastActiveAt: string | null;
  } | null;
  currentRun: {
    id: string;
    status: RunStatus;
    taskSummary: string | null;
    trigger: { source: string; eventType: string } | null;
    startedAt: string | null;
    elapsedSeconds: number;
    progress: {
      phase: string | null;
      percent: number | null;
      summary: string;
      command: string | null;
    };
    events: RunEventDto[];
  } | null;
  recentRuns: Array<{
    id: string;
    status: RunStatus;
    taskSummary: string | null;
    trigger: { source: string; eventType: string } | null;
    durationSeconds: number;
    createdAt: string;
  }>;
  latestInboxEvent: {
    id: string;
    source: string;
    externalEventId: string;
    eventType: string;
    status: InboxEventStatus;
    receivedAt: string;
  } | null;
  runtime: {
    status: "online" | "offline" | "unknown";
    name: string;
    latencyMs: number | null;
  };
}

export interface ProjectListResponse {
  items: ProjectSummary[];
  nextCursor: string | null;
}

export interface RunEventsResponse {
  items: RunEventDto[];
  lastSequence: number;
}

export interface RunDetail {
  id: string;
  projectId: string;
  agentInstanceId: string;
  status: RunStatus;
  taskSummary: string | null;
  resultSummary: string | null;
  mergeRequestUrl: string | null;
  error: { code: string | null; message: string | null } | null;
  trigger: {
    id: string;
    source: string;
    eventType: string;
  } | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRunListItem {
  id: string;
  status: RunStatus;
  taskSummary: string | null;
  resultSummary: string | null;
  mergeRequestUrl: string | null;
  trigger: { source: string; eventType: string } | null;
  durationSeconds: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface InboxEventListItem {
  id: string;
  source: string;
  externalEventId: string;
  eventType: string;
  status: InboxEventStatus;
  retryCount: number;
  errorMessage: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface ProjectRunsResponse {
  items: ProjectRunListItem[];
  nextCursor: string | null;
}

export interface InboxEventsResponse {
  items: InboxEventListItem[];
  nextCursor: string | null;
}

export interface GlobalRunListItem extends ProjectRunListItem {
  project: { id: string; name: string | null; externalProjectId: string };
}

export interface GlobalInboxEventListItem extends InboxEventListItem {
  project: { id: string; name: string | null; externalProjectId: string } | null;
}

export interface GlobalRunsResponse {
  items: GlobalRunListItem[];
  nextCursor: string | null;
}

export interface GlobalInboxEventsResponse {
  items: GlobalInboxEventListItem[];
  nextCursor: string | null;
}

export interface AgentSpecSummary {
  id: string;
  name: string;
  version: number;
  knowledge: Array<{ path: string; when?: string }>;
  sandbox: { dockerfile: string; image: string };
  environmentExample: string;
}

export interface AgentSpecsResponse {
  items: AgentSpecSummary[];
}

export interface AgentSpecUsage {
  statistics: {
    instances: number;
    activeRequirements: number;
    runningInstances: number;
  };
  activeRequirements: Array<{
    associationId: string;
    role: string;
    isPrimary: boolean;
    boundAt: string;
    project: {
      id: string;
      name: string | null;
      externalProjectId: string;
      status: ProjectStatus;
    };
    agentInstance: {
      id: string;
      specVersion: number;
      status: AgentInstanceStatus;
      workspaceKey: string;
      lastActiveAt: string | null;
    };
    currentRun: {
      id: string;
      status: RunStatus;
      taskSummary: string | null;
    } | null;
  }>;
}

export interface AgentSpecOverviewResponse extends AgentSpecUsage {
  spec: AgentSpecSummary;
}

export interface AgentInstanceDetail {
  agentInstance: {
    id: string;
    specKey: string;
    specVersion: number;
    status: AgentInstanceStatus;
    workspaceKey: string;
    threadId: string;
    lastActiveAt: string | null;
    createdAt: string;
  };
  assignment: {
    id: string;
    role: string;
    isPrimary: boolean;
    boundAt: string;
    project: {
      id: string;
      source: string;
      externalProjectId: string;
      externalUrl: string | null;
    };
  } | null;
  currentRun: {
    id: string;
    status: RunStatus;
    taskSummary: string | null;
    startedAt: string | null;
    events: RunEventDto[];
  } | null;
  recentRuns: ProjectRunListItem[];
}

export interface AgentConversationMessage {
  id: string;
  role: "human" | "ai" | "tool" | "system";
  name: string | null;
  content: string;
  toolCallId: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    args: unknown;
  }>;
  status: "success" | "error" | null;
}

export interface AgentConversationResponse {
  threadId: string;
  checkpointId: string | null;
  messages: AgentConversationMessage[];
}
