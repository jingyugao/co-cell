import type { ProjectSummary } from '../../../protocol/types';

export type ProjectWeekGroup = { key: string; label: string; projects: ProjectSummary[] };

export function groupArchivedProjectsByWeek(projects: ProjectSummary[]): ProjectWeekGroup[] {
  const groups = new Map<string, ProjectWeekGroup>();
  for (const project of [...projects].sort((a, b) => (Date.parse(b.archivedAt ?? '') || 0) - (Date.parse(a.archivedAt ?? '') || 0))) {
    const archived = new Date(project.archivedAt ?? '');
    if (!Number.isFinite(archived.getTime())) {
      const unknown = groups.get('unknown') ?? { key: 'unknown', label: '归档日期未知', projects: [] };
      unknown.projects.push(project); groups.set('unknown', unknown); continue;
    }
    const monday = new Date(archived);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
    const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const format = (value: Date, withYear: boolean) => value.toLocaleDateString('zh-CN', { ...(withYear ? { year: 'numeric' as const } : {}), month: '2-digit', day: '2-digit' });
    const label = `${format(monday, true)} — ${format(sunday, monday.getFullYear() !== sunday.getFullYear())}`;
    const group = groups.get(key) ?? { key, label, projects: [] };
    group.projects.push(project); groups.set(key, group);
  }
  return [...groups.values()];
}
