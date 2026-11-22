import type { WorkflowJob, WorkflowModel, WorkflowRole, WorkflowRun } from '../protocol/workflow-types.js';

export function workflowJobTitle(run: WorkflowRun, job: WorkflowJob) {
  if (run.planningMode === 'modules' && job.role === 'plan') return '主 agent · 模块拆分';
  return job.spec?.title ?? job.key;
}

export function workflowModelForRole(run: WorkflowRun, role: WorkflowRole): WorkflowModel {
  if (run.workerModel && role !== 'plan' && role !== 'lead' && role !== 'integration') return run.workerModel;
  return { model: run.model, modelEntryId: run.modelEntryId };
}
