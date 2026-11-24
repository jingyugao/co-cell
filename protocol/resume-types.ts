import type { SandboxResumeProgress } from '@co-cell/sandbox';

export type ProjectResumeStage = SandboxResumeProgress['stage'] | 'received' | 'preparing' | 'syncing' | 'completed';

/** Request-local observations; never saved with the project or replayed on reload. */
export interface ProjectResumeProgress {
  sequence: number;
  stage: ProjectResumeStage;
  at: string;
  elapsedMs: number;
  sandboxId?: string;
  operationId?: string;
  remoteOperationId?: string;
  remoteStatus?: string;
  remoteStage?: string;
  waitPorts?: number[];
  resumePath?: SandboxResumeProgress['resumePath'];
}

export type ProjectResumeObserver = (progress: Omit<ProjectResumeProgress, 'sequence' | 'at' | 'elapsedMs'>) => void;

export interface ProjectResumeError {
  message: string;
  code?: string;
  outcome?: 'failed' | 'unknown';
  status: number;
  at: string;
  elapsedMs: number;
}

/** POST on explicit project activity. Returns the ready ProjectSummary, or a
 * conflict if the bound Sandbox cannot be woken. Safe for concurrent callers. */
export function projectAwakePath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/sandbox/ensure-awake`;
}
