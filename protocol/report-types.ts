export type ReportKind = 'daily' | 'weekly';
export type ReportStatus = 'queued' | 'collecting' | 'summarizing' | 'generating' | 'ready' | 'failed';

export interface ReportSettings {
  revision: number;
  timezone: 'Asia/Shanghai';
  model: string;
  modelEntryId?: string;
  daily: { enabled: boolean; time: string };
  /** ISO weekday (Monday=1); earliest weekly run, after that day's scheduled daily report when enabled. */
  weekly: { enabled: boolean; weekday: number; time: string };
  prompts: { daily: string; weekly: string };
}

export interface ReportUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Number of generation calls without complete provider usage. */
  unknownCalls: number;
  estimatedCostUsd: number | null;
}

export interface WorkReport {
  id: string;
  kind: ReportKind;
  /** Local dates, with an exclusive end. */
  periodStart: string;
  periodEnd: string;
  /** Material cutoff for a daily or weekly snapshot, including delayed scheduled runs. */
  asOf?: string;
  /** Weekly runs freeze completed daily reports as their only inputs. Absent on legacy runs. */
  dailyInputs?: ReportDailyInput[];
  /** Scheduled weekly report waiting for this local date's daily report. */
  waitingForDaily?: string;
  status: ReportStatus;
  sourceCount: number;
  missingCount: number;
  snapshotCount?: number;
  model: string;
  generatedAt?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** System-project sessions used to generate summaries and the final report. */
  sessionIds: string[];
  usage: ReportUsage;
}

export interface ReportDailyInput {
  date: string;
  reportId?: string;
  status: 'included' | 'missing' | 'failed' | 'pending';
  asOf?: string;
  missingCount?: number;
  snapshotCount?: number;
  error?: string;
}

export interface ReportSource {
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string;
  sourceUpdatedAt: string;
  status: 'included' | 'empty' | 'failed';
  materialId?: string;
  /** Some context segments have neither a readable compaction nor in-period raw text. */
  coverageIncomplete?: boolean;
  isSnapshot?: boolean;
  collectedAt?: string;
  summary?: string;
  error?: string;
}

export interface ReportDetail {
  report: WorkReport;
  body: string;
  sources: ReportSource[];
  prompt: string;
}

export interface ReportRetryInput {
  updatedAt: string;
  /** Start a fresh run after checking earlier calls stopped; also permits repairing ready reports with missing sources, preserving their cutoff. */
  regenerate?: boolean;
}

export interface ReportSourceContent {
  content: string;
  nextOffset: number | null;
  totalBytes: number;
}

export interface ReportSchedule {
  kind: ReportKind;
  scheduledAt: string;
  periodStart: string;
  periodEnd: string;
}

export interface ReportsView {
  settings: ReportSettings;
  nextRuns: ReportSchedule[];
  reports: WorkReport[];
  hasMore: boolean;
}
