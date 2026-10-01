import type { ProjectSummary } from '../protocol/types.js';

export function isProjectSandboxReady(project: ProjectSummary): boolean {
  if (project.executionMode !== 'sandbox') return true;
  const operation = project.sandboxOperation;
  return project.sandbox?.status === 'ready' && operation?.status !== 'running'
    && !(operation?.status === 'failed' && ['create', 'resume'].includes(operation.kind));
}

export function canEnterProject(project: ProjectSummary): boolean {
  return (project.status ?? (project.archivedAt ? 'archived' : 'active')) === 'active' && isProjectSandboxReady(project);
}
