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
    const wait = () => new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 250);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
    setState({ key: entryKey, pending: true, error: '' });
    void (async () => {
      const deadline = Date.now() + 5 * 60_000;
      let project = await enter(projectId, signal);
      let resumed = project.sandboxOperation?.kind === 'resume' && project.sandboxOperation.status === 'running';
      for (;;) {
        signal.throwIfAborted();
        if (isProjectSandboxReady(project)) {
          setState({ key: entryKey, pending: false, error: '' });
          return;
        }
        const operation = project.sandboxOperation;
        if (operation?.status === 'failed') throw new Error(operation.error || '环境准备失败，请重试。');
        if (Date.now() >= deadline) throw new Error('环境准备时间较长，请重试查询；输入已保留。');
        // Entry may have joined an in-progress checkpoint. Resume only after
        // it has completed, and do not repeatedly retry a failed restore.
        if (project.sandbox?.status === 'paused' && operation?.status !== 'running' && !resumed) {
          resumed = true;
          project = await enter(projectId, signal);
          continue;
        }
        if (operation?.status !== 'running' && project.sandbox?.status !== 'starting') {
          throw new Error(project.sandbox ? '环境暂不可用，请重试或在项目管理中恢复。' : '环境尚未创建，请在项目管理中重试准备。');
        }
        if (operation?.status === 'running' && operation.id) {
          project = await read(projectId, signal, { waitForOperation: operation.id,
            waitMs: Math.min(PROJECT_OPERATION_WAIT_MS, Math.max(0, deadline - Date.now())) });
        } else {
          // A transition without an operation ID cannot subscribe to completion.
          await wait();
          signal.throwIfAborted();
          project = await read(projectId, signal);
        }
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
