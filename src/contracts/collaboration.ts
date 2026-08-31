export type ProjectTaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface ProjectTask {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  createdBySeatId: string;
  assigneeSeatId: string | null;
  createdByRunId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: ProjectTaskStatus;
  blockedReason: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ProjectPublicationKind = "questions" | "progress" | "phase_result" | "final";

export interface ProjectPublication {
  id: string;
  projectId: string;
  agentSeatId: string;
  runId: string | null;
  taskId: string | null;
  kind: ProjectPublicationKind;
  summary: string;
  relativePath: string;
  sha256: string;
  version: number;
  createdAt: string;
}
