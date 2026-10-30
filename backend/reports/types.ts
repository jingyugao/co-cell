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
  /** Absent on legacy runs, whose submitted prompt hashes must remain stable. */
  materialVersion?: 2 | 3;
  /** A scheduled cutoff waiting for a different same-period snapshot to stop. */
  scheduledAsOf?: string;
  dailyReportIds?: string[];
  rawSourceIds?: string[];
  previousUsage?: ReportUsage;
}

export function publicReport(record: StoredWorkReport): WorkReport {
  const { settings, sources, calls, runId, inputsReady, materialVersion, scheduledAsOf, dailyReportIds, rawSourceIds, previousUsage, ...report } = record;
  return report;
}
