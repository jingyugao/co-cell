import type { PlanTask } from './index.js';

export type WorkflowStatus =
  | 'designing'
  | 'reviewing'
  | 'discussing'
  | 'awaiting_human'
  | 'awaiting_approval'
  | 'executing'
  | 'integrating'
  | 'verifying'
  | 'paused'
  | 'blocked'
  | 'cancelling'
  | 'cancelled'
  | 'completed';
export type WorkflowRole = 'lead' | 'scout' | 'design' | 'review' | 'discussion' | 'plan' | PlanTask['role'];
export type AttemptStatus =
  | 'preparing'
  | 'sending'
  | 'running'
  | 'unknown'
  | 'checking'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export const phaseForRole: Record<WorkflowRole, WorkflowStatus> = {
  lead: 'designing',
  scout: 'designing',
  design: 'designing',
  review: 'reviewing',
  discussion: 'discussing',
  plan: 'discussing',
  worker: 'executing',
  integration: 'integrating',
  verifier: 'verifying',
};
export function isDispatchable(status: WorkflowStatus) {
  return ['designing', 'reviewing', 'discussing', 'executing', 'integrating', 'verifying'].includes(status);
}
export function hasActiveSubmission(status?: AttemptStatus) {
  return !!status && ['sending', 'unknown', 'running', 'checking'].includes(status);
}
