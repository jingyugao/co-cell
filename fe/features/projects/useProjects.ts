import { useCallback, useState } from 'react';
import type { ProjectSummary } from '../../../protocol/types';
import { api } from '../../lib/api';

export type ProjectValues = { name: string; requirementUrl: string | null };
export type ProjectUpdate = Partial<ProjectValues> & { archived?: boolean };

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

  return { projects, refreshProjects, createProject, updateProject };
}
