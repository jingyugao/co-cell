import type { ProjectSummary } from '../protocol/types.js';

export function isProjectSandboxReady(project: ProjectSummary): boolean {
  if (project.executionMode !== 'sandbox') return true;
  const operation = project.sandboxOperation;
  return project.sandbox?.status === 'ready' && operation?.status !== 'running'
    && !(operation?.status === 'failed' && ['create', 'resume', 'rebuild', 'upgrade'].includes(operation.kind));
}

export function canEnterProject(project: ProjectSummary): boolean {
  // Opening a workspace and drafting do not require a running sandbox.
  // Execution continues to use isProjectSandboxReady and the server gate.
  return (project.status ?? (project.archivedAt ? 'archived' : 'active')) === 'active';
}
