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
  assignments: AgentAssignmentResult[];
}

export interface AgentAssignmentResult {
  projectId: string;
  assignmentId: string;
  agentInstance: {
    id: string;
    specKey: string;
    specVersion: number;
    role: string;
    workspaceKey: string;
    threadId: string;
    status: AgentInstanceStatus;
  };
}

export interface StartAgentRunResult {
  runId: string;
  projectId: string;
  agentInstanceId: string;
  status: RunStatus;
}

export interface CancelAgentRunResult {
  runId: string;
  agentInstanceId: string;
  status: "cancelled";
}

export interface ResumeAgentRunInput {
  answers: Record<string, { answers: string[] }>;
}

export interface ResumeAgentRunResult {
  runId: string;
  status: "running";
}
