import { useEffect, useState } from 'react';
import { PROJECT_OPERATION_WAIT_MS, type ProjectReadOptions, type ProjectSummary } from '../../../protocol/types';
import { isProjectSandboxReady } from '../../../util/project-sandbox';
import { errorMessage } from '../../lib/api';

type ReadProject = (id: string, signal?: AbortSignal, options?: ProjectReadOptions) => Promise<ProjectSummary>;

/** Prepare once per workspace entry, independently of the editable prompt draft. */
export function useProjectEntry(projectId: string | null, entryKey: string, enter: ReadProject, read: ReadProject) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ key: '', pending: false, error: '' });
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    const { signal } = controller;
    setState({ key: entryKey, pending: true, error: '' });
    void (async () => {
      const deadline = Date.now() + 5 * 60_000;
      let project = await enter(projectId, signal);
      let reopenedAfterCheckpoint = false;
      for (;;) {
        signal.throwIfAborted();
        const operation = project.sandboxOperation;
        if (operation?.status === 'failed') throw new Error(operation.error || '环境准备失败，请重试。');
        if (operation?.status === 'running' && operation.id) {
          if (Date.now() >= deadline) throw new Error('环境准备时间较长，请重试查询；输入已保留。');
          project = await read(projectId, signal, { waitForOperation: operation.id,
            waitMs: Math.min(PROJECT_OPERATION_WAIT_MS, Math.max(0, deadline - Date.now())) });
          continue;
        }
        // If the initial open budget expired while a checkpoint was still
        // running, submit the original open intent once it is terminal. The
        // backend then performs its authoritative ensure-running check.
        if (operation?.kind === 'checkpoint' && operation.status === 'succeeded' && !reopenedAfterCheckpoint) {
          reopenedAfterCheckpoint = true;
          project = await enter(projectId, signal);
          continue;
        }
        if (!isProjectSandboxReady(project))
          throw new Error(project.sandbox ? '环境暂不可用，请重试或在项目管理中恢复。' : '环境尚未创建，请在项目管理中重试准备。');
        setState({ key: entryKey, pending: false, error: '' });
        return;
      }
    })().catch(error => {
      if (!signal.aborted) setState({ key: entryKey, pending: false, error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [projectId, entryKey, attempt, enter, read]);
  return {
    pending: Boolean(projectId && (state.key !== entryKey || state.pending)),
    error: state.key === entryKey ? state.error : '',
    retry: () => setAttempt(value => value + 1),
  };
}
