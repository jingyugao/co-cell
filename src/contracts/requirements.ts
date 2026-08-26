import type { AgentInstanceStatus, RunStatus } from "./workbench.js";

export interface FeishuWorkItemPreview {
  sourceUrl: string;
  projectKey: string;
  project: { key: string; simpleName: string; name: string };
  workItemId: string;
  workItemType: { key: string; name: string };
  title: string;
  status: { key: string; name: string } | null;
  roles: Array<{
    key: string;
    name: string;
    members: Array<{ key: string; name: string }>;
  }>;
  currentNodes: Array<{
    id: string;
    name: string;
    owners: Array<{ key: string; name: string }>;
    actualBeginTime: string | null;
  }>;
  fields: Array<{ key: string; name: string; value: unknown }>;
  updatedAt: string | null;
  forks: AgentForkResult[];
}

export interface AgentForkResult {
  projectId: string;
  forkId: string;
  role: string;
  agentInstance: {
    id: string;
    specKey: string;
    specVersion: number;
    status: AgentInstanceStatus;
  };
  session: {
    id: string;
    threadId: string;
    workspaceKey: string;
    status: "active" | "waiting" | "closed";
  };
  currentRun: {
    id: string;
    status: RunStatus;
    taskSummary: string | null;
  } | null;
}

export interface StartAgentRunResult {
  runId: string;
  projectId: string;
  agentInstanceId: string;
  forkId: string;
  sessionId: string;
  status: RunStatus;
}

export interface CancelAgentRunResult {
  runId: string;
  agentInstanceId: string;
  status: "cancelled";
}

export interface ResumeAgentRunInput {
  message: string;
}

export interface ResumeAgentRunResult {
  runId: string;
  status: "running";
}
