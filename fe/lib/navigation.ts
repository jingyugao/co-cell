import type { ProjectSummary, SessionSummary } from '../../protocol/types';

export type Page = 'chat' | 'sandboxes' | 'projects' | 'files' | 'connections' | 'improvements' | 'archives';
export type Selection = { sessionId: string | null; projectId: string | null };
const isActiveProject = (project: ProjectSummary) => (project.status ?? (project.archivedAt ? 'archived' : 'active')) === 'active';
const pages: Page[] = ['sandboxes', 'projects', 'files', 'connections', 'improvements'];

export function readRoute(location = window.location) {
  const page: Page = pages.includes(location.hash.slice(1) as Page) ? location.hash.slice(1) as Page : 'chat';
  const match = /^\/(sessions|projects)\/([A-Za-z0-9_-]{1,100})\/?$/.exec(location.pathname);
  return {
    page,
    sessionId: match?.[1] === 'sessions' ? match[2] : null,
    projectId: match?.[1] === 'projects' ? match[2] : null,
    explicit: location.pathname !== '/',
    invalid: location.pathname !== '/' && !match,
  };
}

export function routeUrl(page: Page, selection: Selection): string {
  const path = selection.sessionId ? `/sessions/${encodeURIComponent(selection.sessionId)}`
    : selection.projectId ? `/projects/${encodeURIComponent(selection.projectId)}` : '/';
  return path + (page === 'chat' ? '' : `#${page}`);
}

export function resolveSelection(route: ReturnType<typeof readRoute>, sessions: SessionSummary[], projects: ProjectSummary[]): Selection & { error?: string } {
  if (route.invalid) return { sessionId: null, projectId: null, error: '链接路径无效，请从项目列表选择项目或会话。' };
  if (route.sessionId) {
    const session = sessions.find(item => item.id === route.sessionId);
    const project = projects.find(item => item.id === session?.projectId);
    if (!session || !project) {
      return { sessionId: null, projectId: null, error: '链接中的会话不存在或已删除，请从项目列表选择会话。' };
    }
    if (!isActiveProject(project)) {
      return { sessionId: null, projectId: null, error: '项目已归档或未处于使用中状态，请先在项目管理中恢复。' };
    }
    return { sessionId: session.id, projectId: session.projectId! };
  }
  if (route.projectId) {
    const project = projects.find(item => item.id === route.projectId);
    if (!project) return { sessionId: null, projectId: null, error: '链接中的项目不存在或已删除，请从项目列表选择项目。' };
    return !isActiveProject(project)
      ? { sessionId: null, projectId: null, error: '项目已归档或未处于使用中状态，请先在项目管理中恢复。' }
      : { sessionId: null, projectId: route.projectId };
  }
  const activeProjects = projects.filter(isActiveProject);
  const saved = sessions.find(item => item.id === localStorage.getItem('codex-session')
    && activeProjects.some(project => project.id === item.projectId));
  return {
    sessionId: saved?.id ?? null,
    projectId: saved?.projectId ?? activeProjects.find(item => item.id === localStorage.getItem('codex-project'))?.id
      ?? activeProjects[0]?.id ?? null,
  };
}
