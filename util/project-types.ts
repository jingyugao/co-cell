export type ProjectType = 1 | 2 | 3;

const chinaDateParts = (value: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(value).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));

/** Monday (Asia/Shanghai) for the week containing the supplied instant. */
export function projectWeekOf(value = new Date()): string {
  const parts = chinaDateParts(value);
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export function projectTypeLabel(type: ProjectType | undefined, weekOf?: string, now = new Date()): string {
  if (type === 2) return '飞书项目';
  if (type !== 3) return '普通项目';
  const thisWeek = projectWeekOf(now);
  if (weekOf === thisWeek) return '本周项目';
  const lastWeek = new Date(`${thisWeek}T00:00:00.000Z`);
  lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
  if (weekOf === lastWeek.toISOString().slice(0, 10)) return '上周项目';
  return weekOf ? `${weekOf} 周项目` : '周项目';
}

export function weeklyProjectDisplayName(weekOf: string | undefined, now = new Date()): string {
  const label = projectTypeLabel(3, weekOf, now);
  if (label === '本周项目' || label === '上周项目') return `【${label}】`;
  if (!weekOf || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) return '【周项目】';
  const [year, month, day] = weekOf.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstDaySinceMonday = (firstDay.getUTCDay() + 6) % 7;
  const weekInMonth = Math.floor((day - 1 + firstDaySinceMonday) / 7) + 1;
  return `【${month}月第${weekInMonth}周项目】`;
}

export function projectDisplayName(project: { name: string; type?: ProjectType; weekOf?: string }, now = new Date()): string {
  if (project.type !== 3) return project.name;
  const weeklyName = weeklyProjectDisplayName(project.weekOf, now);
  return !project.name || project.name === '本周项目' ? weeklyName : `${weeklyName} ${project.name}`;
}
