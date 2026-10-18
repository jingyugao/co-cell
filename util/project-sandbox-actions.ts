import type { ProjectSummary } from '../protocol/types.js';

export type ProjectSandboxViewState = 'local' | 'running' | 'paused' | 'released' | 'missing' | 'processing' | 'failed' | 'unknown';
export type ProjectSandboxAction = 'checkpoint' | 'resume' | 'release' | 'create' | 'backup' | 'restore' | 'refresh';

/** Presentation rules only. Cellbox admits every mutation and owns consistency. */
export const projectSandboxActionConfig: Record<ProjectSandboxViewState, { label: string; actions: readonly ProjectSandboxAction[] }> = {
  local: { label: '本地运行', actions: [] },
  running: { label: '运行中', actions: ['checkpoint', 'release'] },
  paused: { label: '已暂停', actions: ['resume', 'backup', 'release'] },
  released: { label: '已释放', actions: ['create', 'backup', 'restore'] },
  missing: { label: '尚未创建', actions: ['create', 'restore'] },
  processing: { label: '处理中', actions: ['refresh'] },
  failed: { label: '异常', actions: ['backup', 'release', 'restore', 'refresh'] },
  unknown: { label: '状态未知', actions: ['refresh', 'release'] },
};

const actionLabels: Record<ProjectSandboxAction, string> = {
  checkpoint: 'Checkpoint · 暂停', resume: '恢复运行', release: '释放运行环境', create: '新建 Sandbox',
  backup: '磁盘备份', restore: '从备份恢复', refresh: '刷新状态',
};
const transitionPhases = new Set(['creating', 'checkpointing', 'suspending', 'resuming', 'restoring', 'staged', 'deleting']);

export function projectSandboxViewState(project: ProjectSummary): ProjectSandboxViewState {
  if (project.executionMode !== 'sandbox') return 'local';
  const sandbox = project.sandbox;
  if (sandbox?.operationId || sandbox?.phase && transitionPhases.has(sandbox.phase)) return 'processing';
  // Pending and uncertain lifecycle requests remain visible after navigation.
  // Backup is independent and never hides the paused Box's resume action.
  const operation = project.sandboxOperation;
  if (operation?.kind !== 'backup') {
    if (operation?.status === 'running') return 'processing';
    if (operation?.status === 'unknown') return 'unknown';
  }
  // A known Cellbox phase takes precedence over the SDK status snapshot.
  if (sandbox?.phase) {
    if (sandbox.phase === 'running') return 'running';
    if (sandbox.phase === 'suspended') return 'paused';
    if (sandbox.phase === 'failed' || sandbox.phase === 'deleted') return 'failed';
    return 'unknown';
  }
  if (!sandbox) return project.sandboxMounts?.length || project.sandboxReclaimedAt
    || project.lifecycleHistory?.some(item => item.action === 'released') ? 'released' : 'missing';
  return { ready: 'running', paused: 'paused', starting: 'processing', unavailable: 'failed', unknown: 'unknown' }[sandbox.status] as ProjectSandboxViewState;
}

export function projectSandboxActions(project: ProjectSummary) {
  const state = projectSandboxViewState(project);
  const config = projectSandboxActionConfig[state];
  const actions = config.actions.filter(id => (id !== 'restore' || Boolean(project.latestBackup) && !project.archiveCleanupSourceId)
      && (id !== 'release' || Boolean(project.sandbox)))
    .map(id => {
      let disabledReason: string | undefined;
      if (id === 'backup') {
        if (state === 'released') disabledReason = 'Cellbox 暂不支持直接备份已释放环境的挂载盘';
        else if (state !== 'paused' && project.sandbox?.phase !== 'failed') disabledReason = '当前 Sandbox 状态不支持备份，请刷新状态';
        else if (project.sandboxBackup?.status === 'running' && project.sandboxBackup.sandboxId === project.sandbox?.id) disabledReason = '磁盘备份正在进行中';
      }
      return { id, label: actionLabels[id], disabledReason };
    });
  return { state, label: config.label, actions };
}
