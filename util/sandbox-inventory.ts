import type { SandboxRecord } from '../protocol/types.js';

export const sandboxInventoryLabels: Record<string, string> = {
  creating: '创建中', running: '运行中', checkpointing: '保存快照中',
  suspending: '暂停中', suspended: '已暂停', paused: '已暂停',
  resuming: '恢复中', restoring: '恢复备份中', staged: '待激活',
  freezing: '冻结中', frozen: '已冻结', unfreezing: '解冻中',
  deleting: '删除中', deleted: '已删除', failed: '异常', unknown: '未知',
};
export function sandboxInventoryPhase(box: SandboxRecord): string {
  return box.phase ?? box.state;
}
export function sandboxInventoryLabel(box: SandboxRecord): string {
  const phase = sandboxInventoryPhase(box);
  return sandboxInventoryLabels[phase] ?? phase;
}
