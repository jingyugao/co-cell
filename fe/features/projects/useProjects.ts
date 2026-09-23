import { useCallback, useState } from 'react';
import type { ProjectSandboxOperation, ProjectStatus, ProjectSummary, ProjectType } from '../../../protocol/types';
import { api } from '../../lib/api';

export type ProjectValues = { name: string; requirementUrl: string | null; type: ProjectType };
export type ProjectUpdate = Partial<ProjectValues> & { status?: ProjectStatus; backupRetentionCount?: number };

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const refreshProjects = useCallback(async () => {
    const list = await api<ProjectSummary[]>('/api/projects');
    setProjects(list);
    return list;
  }, []);
  const storeProject = useCallback((project: ProjectSummary) => {
    setProjects(current => [project, ...current.filter(item => item.id !== project.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    return project;
  }, []);
  const createProject = useCallback(async (values: ProjectValues) => storeProject(
    await api<ProjectSummary>('/api/projects', { method: 'POST', body: JSON.stringify(values) }),
  ), [storeProject]);
  const updateProject = useCallback(async (id: string, values: ProjectUpdate) => storeProject(
    await api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) }),
  ), [storeProject]);
  const runSandboxOperation = useCallback(async (id: string, kind: ProjectSandboxOperation['kind'], request: () => Promise<ProjectSummary>) => {
    const operation: ProjectSandboxOperation = { kind, phase: '提交请求', status: 'running', updatedAt: new Date().toISOString() };
    setProjects(current => current.map(project => project.id === id ? { ...project, sandboxOperation: operation } : project));
    try { return storeProject(await request()); }
    finally { await refreshProjects().catch(() => undefined); }
  }, [refreshProjects, storeProject]);
  const rebuildSandbox = useCallback((id: string) => runSandboxOperation(id, 'restore', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/rebuild`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const backupProject = useCallback((id: string) => runSandboxOperation(id, 'backup', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/backup`, { method: 'POST' }),
  ), [runSandboxOperation]);
  const switchSandbox = useCallback((id: string, targetImageId: string) => runSandboxOperation(id, 'switch', () =>
    api<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}/sandbox/switch-version`, {
      method: 'POST', body: JSON.stringify({ targetImageId }),
    }),
  ), [runSandboxOperation]);
  return { projects, refreshProjects, createProject, updateProject, rebuildSandbox, backupProject, switchSandbox };
}
