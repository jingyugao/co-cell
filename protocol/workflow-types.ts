import type { Check, Finding, Plan, PlanTask } from '../packages/workflow/src/index.js';

export type WorkflowOwner = { kind: 'workflow'; runId: string; taskId: string; writable: boolean };
export type { WorkflowStatus, WorkflowRole, AttemptStatus } from '../packages/workflow/src/state.js';
import type { WorkflowStatus, WorkflowRole, AttemptStatus } from '../packages/workflow/src/state.js';
export type WorkflowPlanningMode = 'modules' | 'reviewed';
export interface WorkflowModel { model: string; modelEntryId?: string }
export interface CreateWorkflowInput {
  projectId: string;
  requirement: string;
  parallelism: number;
  clientRequestId: string;
  planningMode?: WorkflowPlanningMode;
  leadModelEntryId?: string;
  workerModelEntryId?: string;
}
export interface WorkflowAttempt {
  id: string;
  ordinal: number;
  sessionId: string;
  promptHash: string;
  planHash?: string;
  threadId?: string;
  turnId?: string;
  status: AttemptStatus;
  startedAt: string;
  stopRequestedAt?: string;
  nativeStartedAt?: string;
  nativeCompletedAt?: string;
  error?: string;
  artifactId?: string;
  fingerprints?: { before: string | null; after: string | null };
  validation?: Check & {
    status: 'running' | 'unknown' | 'failed' | 'succeeded';
    operationId?: string;
    before?: string;
    exitCode?: number;
    output?: string;
    outputTruncated?: boolean;
  };
}
export interface WorkflowJob {
  id: string;
  key: string;
  version: number;
  role: WorkflowRole;
  instruction: string;
  dependencies: string[];
  attempts: WorkflowAttempt[];
  reuseSessionId?: string;
  spec?: PlanTask;
}
export interface WorkflowArtifact {
  id: string;
  sequence: number;
  jobId: string;
  attemptId: string;
  digest: string;
  value: Finding | Plan;
  createdAt: string;
}
export interface WorkflowPlan {
  version: number;
  id: string;
  hash: string;
  approvalId: string;
  approvalRevision: number;
  artifactId: string;
  plan: Plan;
}
export interface WorkflowRun {
  id: string;
  projectId: string;
  requirement: string;
  model: string;
  modelEntryId?: string;
  /** Runs created before module planning follow the reviewed design workflow. */
  planningMode?: WorkflowPlanningMode;
  workerModel?: WorkflowModel;
  parallelism: number;
  templateVersion: string;
  templateDigest: string;
  status: WorkflowStatus;
  revision: number;
  version: number;
  discussionRound: number;
  createdAt: string;
  updatedAt: string;
  attention?: string;
  pausedFrom?: WorkflowStatus;
  jobs: WorkflowJob[];
  plans: WorkflowPlan[];
  approvedHash?: string;
  decisions: Array<{
    id: string;
    planId: string;
    hash: string;
    actor: string;
    decision: string;
    reason: string;
    at: string;
  }>;
  artifacts: WorkflowArtifact[];
  events: Array<{ sequence: number; message: string; at: string }>;
}
export type WorkflowSummary = Pick<
  WorkflowRun,
  'id' | 'projectId' | 'requirement' | 'status' | 'revision' | 'updatedAt'
>;
