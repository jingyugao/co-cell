import { useCallback, useRef, useState } from 'react';
import { PROJECT_OPERATION_WAIT_MS, type ProjectReadOptions, type ProjectSandboxOperation, type ProjectStatus, type ProjectSummary, type ProjectType } from '../../../protocol/types';
import { api } from '../../lib/api';

export type ProjectValues = { name: string; requirementUrl: string | null; type: ProjectType; imageId?: string; imageVersionId?: string };
export type ProjectUpdate = Partial<Omit<ProjectValues, 'imageId' | 'imageVersionId'>> & { status?: ProjectStatus; backupRetentionCount?: number };

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const sequence = useRef(0);
  const refreshing = useRef<Promise<ProjectSummary[]> | null>(null);
  const refreshProjects = useCallback(() => {
    if (refreshing.current) return refreshing.current;
    const current = ++sequence.current;
    const request = api<ProjectSummary[]>('/api/projects').then(list => {
      if (current === sequence.current) setProjects(list);
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
    const project = await api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/open`, { method: 'POST', signal });
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
  const runSandboxOperation = useCallback(async (id: string, kind: ProjectSandboxOperation['kind'], request: () => Promise<ProjectSummary>) => {
    sequence.current++;
    const operation: ProjectSandboxOperation = { kind, phase: '提交请求', status: 'running', updatedAt: new Date().toISOString() };
    setProjects(current => current.map(project => project.id === id ? { ...project, sandboxOperation: operation } : project));
    try { return storeProject(await request()); }
    catch (error) {
      setProjects(current => current.map(project => project.id === id ? { ...project, sandboxOperation: {
        ...operation, status: 'failed', error: error instanceof Error ? error.message : '请求失败，请刷新状态后重试。',
      } } : project));
      throw error;
    }
    finally { await refreshProjects().catch(() => undefined); }
  }, [refreshProjects, storeProject]);
  const rebuildSandbox = useCallback((id: string, imageVersionId?: string) => runSandboxOperation(id, projects.find(project => project.id === id)?.status === 'archived' ? 'restore' : projects.find(project => project.id === id)?.sandbox ? 'rebuild' : 'create', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/rebuild`, { method: 'POST', body: JSON.stringify(imageVersionId ? { imageVersionId } : {}) }),
  ), [projects, runSandboxOperation]);
  const upgradeSandbox = useCallback((id: string, imageVersionId: string) => runSandboxOperation(id, 'upgrade', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/upgrade`, { method: 'POST', body: JSON.stringify({ imageVersionId }) }),
  ), [runSandboxOperation]);
  const archiveProject = useCallback((id: string) => runSandboxOperation(id, 'archive', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const backupProject = useCallback((id: string) => runSandboxOperation(id, 'backup', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/backup`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const resumeSandbox = useCallback((id: string) => runSandboxOperation(id, 'resume', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/resume`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const checkpointSandbox = useCallback((id: string) => runSandboxOperation(id, 'checkpoint', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/checkpoint`, { method: 'POST' }),
  ), [runSandboxOperation]);
  return { projects, refreshProjects, refreshProject, enterProject, createProject, updateProject, rebuildSandbox, upgradeSandbox, archiveProject, backupProject, resumeSandbox, checkpointSandbox };
}
