export type ReportKind = 'daily' | 'weekly';
export type ReportStatus = 'queued' | 'collecting' | 'summarizing' | 'generating' | 'ready' | 'failed';

export interface ReportSettings {
  revision: number;
  timezone: 'Asia/Shanghai';
  model: string;
  modelEntryId?: string;
  daily: { enabled: boolean; time: string };
  /** ISO weekday (Monday=1); the report always covers the preceding complete week. */
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
  /** Manual snapshot of the current week, separate from its eventual complete report. */
  asOf?: string;
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

export interface ReportSource {
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string;
  sourceUpdatedAt: string;
  status: 'included' | 'empty' | 'failed';
  materialId?: string;
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
