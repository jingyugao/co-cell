export type ConfirmationBlockingScope =
  | "current_phase"
  | "future_phase"
  | "non_blocking"
  | "final_only";

export type ConfirmationStatus =
  | "open"
  | "answer_received"
  | "resolved"
  | "cancelled";

export interface ConfirmationOption {
  label: string;
  description: string;
}

export interface ProjectConfirmation {
  id: string;
  key: string;
  phase: string;
  question: string;
  options: ConfirmationOption[];
  blockingScope: ConfirmationBlockingScope;
  status: ConfirmationStatus;
  artifactUrl: string | null;
  artifactRevision: number | null;
  answer: string | null;
  answerSource: string | null;
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type DeferredItemStatus = "open" | "completed" | "cancelled";
export type DeferredItemReportPolicy = "phase_end" | "final_only";

export interface ProjectDeferredItem {
  id: string;
  key: string;
  phase: string;
  title: string;
  detail: string | null;
  status: DeferredItemStatus;
  reportPolicy: DeferredItemReportPolicy;
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ProjectReport {
  id: string;
  reportType: string;
  phase: string;
  version: number;
  status: string;
  conclusion: string;
  relativePath: string;
  sha256: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ExternalAgentEvent {
  id: string;
  source: string;
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}
