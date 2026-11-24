import type { ProjectSummary } from '../protocol/types.js';

export function isProjectSandboxReady(project: ProjectSummary): boolean {
  if (project.executionMode !== 'sandbox') return true;
  return project.sandbox?.status === 'ready';
}

export function canEnterProject(project: ProjectSummary): boolean {
  // Opening a workspace and drafting do not require a running sandbox.
  // Execution continues to use isProjectSandboxReady and the server gate.
  return (project.status ?? (project.archivedAt ? 'archived' : 'active')) === 'active';
}

/** Only a confirmed pause on the bound Box can start an automatic resume. */
export function canAutoResumeProject(project: ProjectSummary): boolean {
  const box = project.sandbox;
  const operation = project.sandboxOperation;
  if (!canEnterProject(project) || project.executionMode !== 'sandbox' || box?.status !== 'paused'
      || box.creation || box.operationId || (box.phase && box.phase !== 'suspended')) return false;
  if (operation?.kind === 'resume' && operation.status === 'failed') return false;
  return operation?.kind === 'backup' || (operation?.status !== 'running' && operation?.status !== 'unknown');
}
