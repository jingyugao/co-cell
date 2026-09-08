import type { ProjectSummary, SessionSummary } from '../../shared/types';

export type Page = 'chat' | 'sandboxes' | 'projects' | 'files' | 'templates' | 'connections' | 'improvements';
export type Selection = { sessionId: string | null; projectId: string | null };
const pages: Page[] = ['sandboxes', 'projects', 'files', 'templates', 'connections', 'improvements'];

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
    if (!session || !projects.some(project => project.id === session.projectId)) {
      return { sessionId: null, projectId: null, error: '链接中的会话不存在或已删除，请从项目列表选择会话。' };
    }
    return { sessionId: session.id, projectId: session.projectId! };
  }
  if (route.projectId) {
    return projects.some(project => project.id === route.projectId)
      ? { sessionId: null, projectId: route.projectId }
      : { sessionId: null, projectId: null, error: '链接中的项目不存在或已删除，请从项目列表选择项目。' };
  }
  const saved = sessions.find(item => item.id === localStorage.getItem('codex-session') && projects.some(project => project.id === item.projectId));
  return {
    sessionId: saved?.id ?? null,
    projectId: saved?.projectId ?? projects.find(item => item.id === localStorage.getItem('codex-project'))?.id
      ?? projects.find(item => !item.archivedAt)?.id ?? projects[0]?.id ?? null,
  };
}
