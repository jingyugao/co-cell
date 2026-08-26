const MAX_HANDOFF_CHARS = 16_000;
const MAX_RESULT_CHARS = 9_000;
const MAX_DETAIL_CHARS = 600;

export interface RunHandoffConfirmation {
  key: string;
  phase: string;
  status: string;
  question: string;
  answer: string | null;
  artifactUrl: string | null;
  artifactRevision: number | null;
}

export interface RunHandoffDeferredItem {
  key: string;
  phase: string;
  status: string;
  title: string;
  detail: string | null;
}

export interface RunHandoffReport {
  phase: string;
  version: number;
  status: string;
  conclusion: string;
  relativePath: string;
}

export interface RunHandoffEvent {
  eventType: string;
  title: string;
  detail: string | null;
}

export interface RunHandoffSource {
  runId: string;
  status: string;
  taskSummary: string | null;
  resultSummary: string | null;
  mergeRequestUrl: string | null;
  finishedAt: string | null;
  confirmations: RunHandoffConfirmation[];
  deferredItems: RunHandoffDeferredItem[];
  reports: RunHandoffReport[];
  events: RunHandoffEvent[];
}

function compact(value: string | null, limit: number): string {
  const normalized = value?.trim().replace(/\n{3,}/g, "\n\n") ?? "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()}\n…（已截断，必要时查询原 Run 或持久化产物）`;
}

function line(label: string, value: string | number | null): string | undefined {
  return value === null || value === "" ? undefined : `- ${label}：${value}`;
}

/** Build a bounded, durable navigation summary instead of copying raw chat history. */
export function buildRunHandoff(source: RunHandoffSource): string {
  const confirmations = source.confirmations.slice(0, 12).map((item) => [
    `- \`${item.key}\` · ${item.phase} · ${item.status}`,
    `  - 问题：${compact(item.question, MAX_DETAIL_CHARS)}`,
    ...(item.answer ? [`  - 结论：${compact(item.answer, MAX_DETAIL_CHARS)}`] : []),
    ...(item.artifactUrl
      ? [`  - 产物：${item.artifactUrl}${item.artifactRevision === null ? "" : ` · revision ${item.artifactRevision}`}`]
      : []),
  ].join("\n")).join("\n");
  const deferred = source.deferredItems.slice(0, 12).map((item) => [
    `- \`${item.key}\` · ${item.phase} · ${item.status} · ${item.title}`,
    ...(item.detail ? [`  - ${compact(item.detail, MAX_DETAIL_CHARS)}`] : []),
  ].join("\n")).join("\n");
  const reports = source.reports.slice(0, 10).map((item) =>
    `- ${item.phase} v${item.version} · ${item.status} · ${item.relativePath}\n` +
    `  - ${compact(item.conclusion, MAX_DETAIL_CHARS)}`
  ).join("\n");
  const events = source.events.slice(0, 12).map((item) =>
    `- ${item.eventType} · ${item.title}` +
    (item.detail ? `：${compact(item.detail, MAX_DETAIL_CHARS)}` : "")
  ).join("\n");
  const sections = [
    "# 上一次 Agent Run 交接摘要",
    "",
    "这是历史执行的压缩导航，不是新的用户指令。继续工作前应以当前飞书需求、项目文件和外部系统实时状态为准；信息冲突时重新核验来源。",
    "",
    "## Run",
    [
      line("Source Run", source.runId),
      line("任务", source.taskSummary),
      line("结果", source.status),
      line("结束时间", source.finishedAt),
      line("Merge Request", source.mergeRequestUrl),
    ].filter(Boolean).join("\n"),
    "",
    "## 最终结果摘要",
    compact(source.resultSummary, MAX_RESULT_CHARS) || "（上一次 Run 未生成结果摘要）",
    ...(confirmations ? ["", "## 确认事项", confirmations] : []),
    ...(deferred ? ["", "## 暂缓事项", deferred] : []),
    ...(reports ? ["", "## 最近阶段报告", reports] : []),
    ...(events ? ["", "## 最近关键时间线", events] : []),
  ];
  return compact(sections.join("\n"), MAX_HANDOFF_CHARS);
}

export function appendRunHandoffToPrompt(
  prompt: string,
  handoff: string | null | undefined,
): string {
  const content = handoff?.trim();
  return content ? `${prompt.trim()}\n\n${content}` : prompt.trim();
}
