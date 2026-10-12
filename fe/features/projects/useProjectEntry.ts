import { useEffect, useState } from 'react';
import type { ProjectSummary } from '../../../protocol/types';
import { isProjectSandboxReady } from '../../../util/project-sandbox';
import { errorMessage } from '../../lib/api';

type EnterProject = (id: string, signal?: AbortSignal) => Promise<ProjectSummary>;

/** Prepare once per workspace entry, independently of the editable prompt draft. */
export function useProjectEntry(projectId: string | null, entryKey: string, enter: EnterProject) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ key: '', pending: false, error: '' });
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    const { signal } = controller;
    setState({ key: entryKey, pending: true, error: '' });
    void (async () => {
      const project = await enter(projectId, signal);
      signal.throwIfAborted();
      const operation = project.sandboxOperation;
      if (operation?.status === 'failed') throw new Error(operation.error || '环境准备失败，请重试。');
      if (!isProjectSandboxReady(project))
        throw new Error(project.sandbox ? '环境暂不可用，请重试或在项目管理中恢复。' : '环境尚未创建，请在项目管理中重试准备。');
      setState({ key: entryKey, pending: false, error: '' });
    })().catch(error => {
      if (!signal.aborted) setState({ key: entryKey, pending: false, error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [projectId, entryKey, attempt, enter]);
  return {
    pending: Boolean(projectId && (state.key !== entryKey || state.pending)),
    error: state.key === entryKey ? state.error : '',
    retry: () => setAttempt(value => value + 1),
  };
}
