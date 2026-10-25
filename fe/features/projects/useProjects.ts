import { useCallback, useRef, useState } from 'react';
import { PROJECT_OPERATION_WAIT_MS, type ProjectReadOptions, type ProjectSandboxOperation, type ProjectStatus, type ProjectSummary, type ProjectType } from '../../../protocol/types';
import { api, ApiError } from '../../lib/api';

export type ProjectValues = { name: string; requirementUrl: string | null; type: ProjectType; imageId?: string; imageVersionId?: string };
export type ProjectUpdate = Partial<Omit<ProjectValues, 'imageId' | 'imageVersionId'>> & { status?: ProjectStatus };

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [hasProjectIndex, setHasProjectIndex] = useState(false);
  const sequence = useRef(0);
  const refreshing = useRef<Promise<ProjectSummary[]> | null>(null);
  const refreshProjects = useCallback(() => {
    if (refreshing.current) return refreshing.current;
    const current = ++sequence.current;
    const request = api<ProjectSummary[]>('/api/projects').then(list => {
      if (current === sequence.current) { setProjects(list); setHasProjectIndex(true); }
      return list;
    }).finally(() => { if (refreshing.current === request) refreshing.current = null; });
    refreshing.current = request;
    return request;
  }, []);
  const storeProject = useCallback((project: ProjectSummary) => {
    sequence.current++;
    setProjects(current => [project, ...current.filter(item => item.id !== project.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    return project;
  }, []);
  const createProject = useCallback(async (values: ProjectValues) => storeProject(
    await api<ProjectSummary>('/api/projects', { method: 'POST', body: JSON.stringify(values) }),
  ), [storeProject]);
  const enterProject = useCallback(async (id: string, signal?: AbortSignal) => {
    const project = await api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}`, { signal });
    signal?.throwIfAborted();
    return storeProject(project);
  }, [storeProject]);
  const refreshProject = useCallback(async (id: string, signal?: AbortSignal, options?: ProjectReadOptions) => {
    const query = options?.waitForOperation ? `?${new URLSearchParams({
      waitForOperation: options.waitForOperation, waitMs: String(options.waitMs ?? PROJECT_OPERATION_WAIT_MS),
    })}` : '';
    const project = await api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}${query}`, { signal });
    signal?.throwIfAborted();
    return storeProject(project);
  }, [storeProject]);
  const updateProject = useCallback(async (id: string, values: ProjectUpdate) => storeProject(
    await api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) }),
  ), [storeProject]);
  const deleteProject = useCallback(async (id: string) => {
    sequence.current++;
    const operation: ProjectSandboxOperation = { kind: 'delete', phase: '提交删除请求', status: 'running', updatedAt: new Date().toISOString() };
    setProjects(current => current.map(project => project.id === id ? { ...project, status: 'deleting', sandboxOperation: operation } : project));
    try {
      await api<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      sequence.current++;
      setProjects(current => current.filter(project => project.id !== id));
    } catch (error) {
      let refreshed: ProjectSummary | undefined;
      try { refreshed = await refreshProject(id); }
      catch (refreshError) {
        if (refreshError instanceof ApiError && refreshError.status === 404) {
          sequence.current++;
          setProjects(current => current.filter(project => project.id !== id));
        }
      }
      if (!refreshed?.sandboxOperation || refreshed.sandboxOperation.kind !== 'delete') {
        setProjects(current => current.map(project => project.id === id ? { ...project, sandboxOperation: {
          ...operation, status: !(error instanceof ApiError) || ['UNKNOWN_OUTCOME', 'TRANSPORT'].includes(error.code ?? '') ? 'unknown' : 'failed',
          errorCode: error instanceof ApiError ? error.code : undefined,
          error: error instanceof Error ? error.message : '删除结果未知，请刷新状态后决定下一步。',
        } } : project));
      }
      throw error;
    }
  }, [refreshProject]);
  const runSandboxOperation = useCallback(async (id: string, kind: ProjectSandboxOperation['kind'], request: () => Promise<ProjectSummary>) => {
    sequence.current++;
    const operation: ProjectSandboxOperation = { kind, phase: '提交请求', status: 'running', updatedAt: new Date().toISOString() };
    setProjects(current => current.map(project => project.id === id ? { ...project, sandboxOperation: operation } : project));
    try { return storeProject(await request()); }
    catch (error) {
      setProjects(current => current.map(project => project.id === id ? { ...project, sandboxOperation: {
        ...operation, status: !(error instanceof ApiError) || ['UNKNOWN_OUTCOME', 'TRANSPORT'].includes(error.code ?? '') ? 'unknown' : 'failed', errorCode: error instanceof ApiError ? error.code : undefined, error: error instanceof Error ? error.message : '请求结果未知，请查询状态后决定下一步。',
      } } : project));
      throw error;
    }
    finally { await refreshProjects().catch(() => undefined); }
  }, [refreshProjects, storeProject]);
  const createSandbox = useCallback((id: string) => runSandboxOperation(id, 'create', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/create`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const restoreSandbox = useCallback((id: string, imageVersionId?: string) => runSandboxOperation(id, 'restore', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/restore`, { method: 'POST', body: JSON.stringify(imageVersionId ? { imageVersionId } : {}) }),
  ), [runSandboxOperation]);
  const releaseSandbox = useCallback((id: string) => runSandboxOperation(id, 'release', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/release`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const resumeSandbox = useCallback((id: string) => runSandboxOperation(id, 'resume', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/resume`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const checkpointSandbox = useCallback((id: string) => runSandboxOperation(id, 'checkpoint', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/checkpoint`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const backupSandbox = useCallback((id: string) => runSandboxOperation(id, 'backup', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/backup`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const archiveProject = useCallback((id: string, options: { useExistingBackup?: boolean } = {}) => runSandboxOperation(id, 'archive', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify(options) }),
  ), [runSandboxOperation]);
  return { projects, hasProjectIndex, refreshProjects, refreshProject, enterProject, createProject, updateProject, deleteProject, createSandbox, restoreSandbox, releaseSandbox, resumeSandbox, checkpointSandbox, backupSandbox, archiveProject };
}
