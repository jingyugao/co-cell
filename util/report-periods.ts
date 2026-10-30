import type { ReportKind, ReportSchedule, ReportSettings } from '../protocol/report-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_DUE_RANGE_MS = 31 * DAY_MS;

function parseDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期必须使用 YYYY-MM-DD 格式');
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day)
    throw new Error('日期无效');
  return parsed;
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function mondayOf(date: Date): Date {
  const weekday = date.getUTCDay() || 7;
  return addDays(date, 1 - weekday);
}

function validateTime(time: string): { hour: number; minute: number } {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('时间必须使用有效的 HH:mm 格式');
  return { hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) };
}

function validateSettings(settings: ReportSettings): void {
  if (settings.timezone !== 'Asia/Shanghai') throw new Error('仅支持 Asia/Shanghai 时区');
  validateTime(settings.daily.time);
  validateTime(settings.weekly.time);
  if (!Number.isInteger(settings.weekly.weekday) || settings.weekly.weekday < 1 || settings.weekly.weekday > 7)
    throw new Error('周报 weekday 必须为 ISO 星期 1-7');
}

// A fixed weekly clock cannot race the daily report it summarizes. Completion
// is checked by the worker; this clock is only the earliest eligible time.
function weeklyTime(settings: ReportSettings): string {
  return settings.daily.enabled && settings.daily.time > settings.weekly.time ? settings.daily.time : settings.weekly.time;
}

function scheduleOn(kind: ReportKind, executionDate: Date, time: string): ReportSchedule {
  const { hour, minute } = validateTime(time);
  // Dates are represented as UTC calendar days; shift the wall clock by the
  // fixed Shanghai offset when constructing the actual instant.
  const scheduled = new Date(Date.UTC(executionDate.getUTCFullYear(), executionDate.getUTCMonth(), executionDate.getUTCDate(), hour, minute)
    - SHANGHAI_OFFSET_MS);
  const periodStart = kind === 'daily' ? executionDate : mondayOf(executionDate);
  const periodEnd = addDays(periodStart, kind === 'daily' ? 1 : 7);
  return { kind, scheduledAt: scheduled.toISOString(), periodStart: dateString(periodStart), periodEnd: dateString(periodEnd) };
}

/** Returns the local date's daily period or its containing Monday-based week (end exclusive). */
export function reportPeriod(kind: ReportKind, date: string): { periodStart: string; periodEnd: string } {
  const parsed = parseDate(date);
  if (kind === 'daily') return { periodStart: date, periodEnd: dateString(addDays(parsed, 1)) };
  if (kind !== 'weekly') throw new Error('未知报告类型');
  const start = mondayOf(parsed);
  return { periodStart: dateString(start), periodEnd: dateString(addDays(start, 7)) };
}

/** Returns the next enabled run for each kind, strictly after now, in Shanghai local time. */
export function reportSchedule(settings: ReportSettings, now = new Date()): ReportSchedule[] {
  validateSettings(settings);
  if (!Number.isFinite(now.getTime())) throw new Error('now 必须是有效日期');
  const localToday = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const result: ReportSchedule[] = [];
  if (settings.daily.enabled) {
    for (let offset = 0; offset <= 1; offset++) {
      const candidate = scheduleOn('daily', addDays(new Date(Date.UTC(localToday.getUTCFullYear(), localToday.getUTCMonth(), localToday.getUTCDate())), offset), settings.daily.time);
      if (Date.parse(candidate.scheduledAt) > now.getTime()) { result.push(candidate); break; }
    }
  }
  if (settings.weekly.enabled) {
    const today = new Date(Date.UTC(localToday.getUTCFullYear(), localToday.getUTCMonth(), localToday.getUTCDate()));
    const currentWeekday = today.getUTCDay() || 7;
    let days = (settings.weekly.weekday - currentWeekday + 7) % 7;
    let candidate = scheduleOn('weekly', addDays(today, days), weeklyTime(settings));
    if (Date.parse(candidate.scheduledAt) <= now.getTime()) {
      days += 7;
      candidate = scheduleOn('weekly', addDays(today, days), weeklyTime(settings));
    }
    result.push(candidate);
  }
  return result.sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt));
}

/**
 * Returns enabled occurrences in (since, now], sorted by execution time.
 * The caller must query in windows no longer than 31 days; larger ranges throw
 * so a scheduler cannot accidentally perform an unbounded backfill scan.
 */
export function dueReportSchedules(settings: ReportSettings, since: Date, now: Date): ReportSchedule[] {
  validateSettings(settings);
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(now.getTime())) throw new Error('since 和 now 必须是有效日期');
  if (since.getTime() > now.getTime()) throw new Error('since 不能晚于 now');
  if (now.getTime() - since.getTime() > MAX_DUE_RANGE_MS) throw new Error('调度补漏范围不能超过 31 天');
  const firstLocalDay = new Date(since.getTime() + SHANGHAI_OFFSET_MS);
  const lastLocalDay = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const first = Date.UTC(firstLocalDay.getUTCFullYear(), firstLocalDay.getUTCMonth(), firstLocalDay.getUTCDate());
  const last = Date.UTC(lastLocalDay.getUTCFullYear(), lastLocalDay.getUTCMonth(), lastLocalDay.getUTCDate());
  const result: ReportSchedule[] = [];
  for (let day = first; day <= last; day += DAY_MS) {
    const date = new Date(day);
    if (settings.daily.enabled) result.push(scheduleOn('daily', date, settings.daily.time));
    if (settings.weekly.enabled && (date.getUTCDay() || 7) === settings.weekly.weekday)
      result.push(scheduleOn('weekly', date, weeklyTime(settings)));
  }
  return result.filter(item => {
    const at = Date.parse(item.scheduledAt);
    return at > since.getTime() && at <= now.getTime();
  }).sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt));
}
