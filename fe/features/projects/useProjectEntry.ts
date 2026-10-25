import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '../../../protocol/types';
import { isProjectSandboxReady } from '../../../util/project-sandbox';
import { errorMessage } from '../../lib/api';

type EnterProject = (id: string, signal?: AbortSignal) => Promise<ProjectSummary>;

/** Read once per workspace entry; never resume or prepare a remote environment. */
export function useProjectEntry(projectId: string | null, entryKey: string, enter: EnterProject, bootstrapProject?: ProjectSummary | null) {
  const [attempt, setAttempt] = useState(0);
  const entered = useRef(false);
  const [state, setState] = useState({ key: '', pending: false, error: '' });
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    const { signal } = controller;
    const initial = !entered.current && bootstrapProject?.id === projectId ? bootstrapProject : null;
    entered.current = true;
    setState({ key: entryKey, pending: true, error: '' });
    void (async () => {
      const project = initial ?? await enter(projectId, signal);
      signal.throwIfAborted();
      const operation = project.sandboxOperation;
      if (!isProjectSandboxReady(project) && (operation?.status === 'failed' || operation?.status === 'unknown')) throw new Error(operation.error || '操作尚未确认，请查询状态后决定下一步。');
      if (!isProjectSandboxReady(project))
        throw new Error(project.sandbox?.status === 'paused' ? '环境已暂停，请在项目管理中点击恢复运行。' : project.sandbox ? '环境暂不可用，请在项目管理中查看状态。' : '环境尚未创建，请在项目管理中创建。');
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
