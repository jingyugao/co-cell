import type { ReportSettings, ReportSource, ReportUsage, WorkReport } from '../../protocol/report-types.js';

export interface ReportCall {
  key: string;
  status: 'pending' | 'submitting' | 'running' | 'ready' | 'failed';
  sessionId?: string;
  turnId?: string;
  usage?: ReportUsage;
  startedAt?: string;
  /** Allow a briefly stale interrupted snapshot to settle without resubmitting input. */
  cancelledAt?: string;
  error?: string;
}

export interface StoredWorkReport extends WorkReport {
  settings: ReportSettings;
  sources: ReportSource[];
  calls: ReportCall[];
  /** A new immutable output directory for each explicit retry. */
  runId: string;
  inputsReady?: boolean;
  dailyReportIds?: string[];
  rawSourceIds?: string[];
  previousUsage?: ReportUsage;
}

export function publicReport(record: StoredWorkReport): WorkReport {
  const { settings, sources, calls, runId, inputsReady, dailyReportIds, rawSourceIds, previousUsage, ...report } = record;
  return report;
}
