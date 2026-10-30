import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReportDetail, ReportKind, ReportSettings, ReportsView, ReportSourceContent, WorkReport } from '../../../protocol/report-types';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';
import Markdown from '../chat/Markdown';
import './ReportsPage.css';

const active = new Set(['queued', 'collecting', 'summarizing', 'generating']);
const statusLabels: Record<WorkReport['status'], string> = { queued: '排队中', collecting: '整理材料', summarizing: '提炼进展', generating: '生成报告', ready: '已完成', failed: '失败' };
const kinds: Record<ReportKind, string> = { daily: '日报', weekly: '周报' };
const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
const dateOnly = (value: string) => value ? value.slice(0, 10) : '—';
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const beijingToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const mondayOf = (date: string) => {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return addDays(date, 1 - weekday);
};
const reportsByWeek = (reports: WorkReport[]) => {
  const weeks = new Map<string, WorkReport[]>();
  for (const report of reports) {
    const start = mondayOf(dateOnly(report.periodStart));
    const entries = weeks.get(start) ?? [];
    entries.push(report);
    weeks.set(start, entries);
  }
  return [...weeks].sort(([left], [right]) => right.localeCompare(left)).map(([start, entries]) => ({
    start,
    reports: entries.sort((left, right) => Number(right.kind === 'weekly') - Number(left.kind === 'weekly')
      || right.periodStart.localeCompare(left.periodStart)
      || (right.generatedAt ?? right.createdAt).localeCompare(left.generatedAt ?? left.createdAt)
      || left.id.localeCompare(right.id)),
  }));
};
const dateLimit = (_kind: ReportKind, today = beijingToday()) => today;
const defaultDate = (kind: ReportKind, today = beijingToday()) => kind === 'daily'
  ? today
  : mondayOf(today);
const dateRange = (kind: ReportKind, date: string, today = beijingToday()) => kind === 'daily'
  ? date === today ? `${date} 至现在（当日快照）` : date
  : mondayOf(date) === mondayOf(today) ? `${mondayOf(date)} 至现在（本周快照，北京时间）`
    : `${mondayOf(date)} 至 ${addDays(mondayOf(date), 6)}`;
const feeLabel = (value: number | null, unknownCalls: number) => value === null ? '本次新增预估费用未知'
  : unknownCalls > 0 ? `本次新增预估费用（文本估算） $${value.toFixed(4)}（实际以渠道账单为准）`
    : `本次新增预估费用 $${value.toFixed(4)}`;
const lastIncludedDay = (exclusiveEnd: string) => {
  const value = new Date(`${exclusiveEnd.slice(0, 10)}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
};
const range = (start: string, exclusiveEnd: string) => `${dateOnly(start)} 至 ${lastIncludedDay(exclusiveEnd)}`;
const period = (report: WorkReport) => range(report.periodStart, report.periodEnd);
const reportAsOf = (report: WorkReport) => report.asOf;
const snapshotLabel = (report: WorkReport) => report.kind === 'daily' ? '当日快照' : '本周快照';
const reportPeriod = (report: WorkReport) => reportAsOf(report)
  ? `${dateOnly(report.periodStart)} 至 ${dateLabel(reportAsOf(report))}（${snapshotLabel(report)}）`
  : period(report);
type SourceMaterial = { content?: string; nextOffset: number | null; totalBytes: number; loading: boolean; error?: string; open: boolean };
const dailyInputsOf = (report: WorkReport) => report.dailyInputs;
const sourceFingerprint = (source?: ReportDetail['sources'][number]) => source ? `${source.materialId ?? ''}|${source.sourceUpdatedAt}|${source.status}` : undefined;
const resetInterruptedLoads = (materials: Record<string, SourceMaterial>) => Object.fromEntries(Object.entries(materials).map(([key, material]) => [key, material.loading
  ? { ...material, loading: false, error: material.content === undefined ? '材料读取中断，请重试。' : undefined }
  : material]));

export default function ReportsPage({ onMenu, onBack }: { onMenu: () => void; onBack: () => void }) {
  const [view, setView] = useState<ReportsView | null>(null);
  const [draft, setDraft] = useState<ReportSettings | null>(null);
  const [baseline, setBaseline] = useState('');
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [sourceMaterials, setSourceMaterials] = useState<Record<string, SourceMaterial>>({});
  const sourceLoads = useRef(new Set<string>());
  const detailRef = useRef<ReportDetail | null>(null);
  const detailRequest = useRef(0);
  const sourceGeneration = useRef(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [selectedKind, setSelectedKind] = useState<ReportKind>('daily');
  const [selectedDate, setSelectedDate] = useState(() => defaultDate('daily'));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const draftRef = useRef<ReportSettings | null>(null);
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);
  const hasActive = Boolean(view?.reports.some(item => active.has(item.status)));
  const generationSessions = detail ? Array.from(new Set(detail.report.sessionIds)) : [];
  const weeks = reportsByWeek(view?.reports ?? []);

  const refresh = useCallback(async (initial = false) => {
    try {
      const result = await api<ReportsView>('/api/reports?offset=0&limit=50');
      setView(result); setError('');
      const current = draftRef.current;
      if (!current || JSON.stringify(current) === baseline) {
        draftRef.current = result.settings; setDraft(result.settings); setBaseline(JSON.stringify(result.settings));
      }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { if (initial) setLoading(false); }
  }, [baseline]);

  useEffect(() => { void refresh(true); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (hasActive) void refresh(); }, 8000);
    return () => window.clearInterval(timer);
  }, [hasActive, refresh]);
  useEffect(() => {
    if (!detail || !active.has(detail.report.status)) return;
    const timer = window.setInterval(() => void loadDetail(detail.report.id), 6000);
    return () => window.clearInterval(timer);
  }, [detail?.report.id, detail?.report.status]);

  function patchSettings(patch: Partial<ReportSettings>) {
    const current = draftRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    draftRef.current = next;
    setDraft(next);
  }

  async function saveSettings() {
    if (!draft || saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await api<ReportSettings>('/api/reports/settings', { method: 'PUT', body: JSON.stringify(draft) });
      draftRef.current = result; setDraft(result); setBaseline(JSON.stringify(result));
      setView(current => current ? { ...current, settings: result } : current); setNotice('报告设置已保存。');
      void refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }

  async function loadDetail(id: string) {
    const request = ++detailRequest.current;
    try {
      const next = await api<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`);
      if (request !== detailRequest.current) return;
      const previous = detailRef.current;
      const sameReport = previous?.report.id === next.report.id;
      const newRun = sameReport && previous.report.generatedAt !== next.report.generatedAt;
      const oldSources = new Map(previous?.sources.map(source => [source.sessionId, sourceFingerprint(source)]) ?? []);
      const newSources = new Map(next.sources.map(source => [source.sessionId, sourceFingerprint(source)]));
      const changedSourceIds = new Set([...oldSources.keys(), ...newSources.keys()].filter(sessionId => oldSources.get(sessionId) !== newSources.get(sessionId)));
      if (previous && (!sameReport || newRun || changedSourceIds.size > 0)) {
        sourceGeneration.current++;
        setSourceMaterials(value => resetInterruptedLoads(Object.fromEntries(Object.entries(value).filter(([key]) => {
          if (!sameReport || !key.startsWith(`${next.report.id}:`)) return true;
          if (newRun) return false;
          return !changedSourceIds.has(key.slice(next.report.id.length + 1));
        }))));
      }
      detailRef.current = next;
      setDetail(next); setError('');
    }
    catch (cause) { setError(errorMessage(cause)); }
  }

  function closeDetail() {
    detailRequest.current++;
    sourceGeneration.current++;
    setSourceMaterials(resetInterruptedLoads);
    detailRef.current = null;
    setDetail(null);
  }

  async function loadSourceMaterial(sessionId: string, offset: number) {
    if (!detail) return;
    const key = `${detail.report.id}:${sessionId}`;
    const generation = sourceGeneration.current;
    const loadKey = `${generation}:${key}`;
    if (sourceLoads.current.has(loadKey)) return;
    sourceLoads.current.add(loadKey);
    setSourceMaterials(value => generation !== sourceGeneration.current || detailRef.current?.report.id !== detail.report.id ? value : ({ ...value, [key]: { ...value[key], open: true, loading: true, error: undefined, nextOffset: value[key]?.nextOffset ?? null, totalBytes: value[key]?.totalBytes ?? 0 } }));
    try {
      const result = await api<ReportSourceContent>(`/api/reports/${encodeURIComponent(detail.report.id)}/sources/${encodeURIComponent(sessionId)}?offset=${offset}`);
      const currentSource = detailRef.current?.sources.find(source => source.sessionId === sessionId);
      const requestedSource = detail.sources.find(source => source.sessionId === sessionId);
      if (generation !== sourceGeneration.current || detailRef.current?.report.id !== detail.report.id || sourceFingerprint(currentSource) !== sourceFingerprint(requestedSource)) return;
      setSourceMaterials(value => {
        if (generation !== sourceGeneration.current || detailRef.current?.report.id !== detail.report.id) return value;
        const current = value[key];
        const content = offset === 0 ? result.content : `${current?.content ?? ''}${result.content}`;
        return { ...value, [key]: { open: true, loading: false, content, nextOffset: result.nextOffset ?? null, totalBytes: result.totalBytes ?? utf8Bytes(content) } };
      });
    } catch (cause) {
      if (generation !== sourceGeneration.current || detailRef.current?.report.id !== detail.report.id) return;
      setSourceMaterials(value => generation !== sourceGeneration.current || detailRef.current?.report.id !== detail.report.id ? value : ({ ...value, [key]: { ...value[key], open: true, loading: false, error: errorMessage(cause), nextOffset: value[key]?.nextOffset ?? null, totalBytes: value[key]?.totalBytes ?? 0 } }));
    } finally {
      sourceLoads.current.delete(loadKey);
    }
  }

  async function toggleSourceMaterial(sessionId: string) {
    if (!detail) return;
    const key = `${detail.report.id}:${sessionId}`;
    const current = sourceMaterials[key];
    if (current?.open) {
      setSourceMaterials(value => ({ ...value, [key]: { ...current, open: false } }));
      return;
    }
    if (current?.content !== undefined) {
      setSourceMaterials(value => ({ ...value, [key]: { ...current, open: true } }));
      return;
    }
    await loadSourceMaterial(sessionId, 0);
  }

  async function generate() {
    if (generating || selectedDate > dateLimit(selectedKind)) return;
    setGenerating(true); setError(''); setNotice('');
    try {
      const report = await api<WorkReport>('/api/reports', { method: 'POST', body: JSON.stringify({ kind: selectedKind, date: selectedDate }) });
      setNotice(`${kinds[report.kind]}已提交，统计范围：${reportPeriod(report)}。`);
      await refresh(); await loadDetail(report.id);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setGenerating(false); }
  }

  async function retry(regenerate = false) {
    if (!detail || retrying || !(detail.report.status === 'failed'
      || regenerate && detail.report.status === 'ready' && detail.report.missingCount > 0)) return;
    setRetrying(true); setError(''); setNotice('');
    try {
      await api<{ ok: true }>(`/api/reports/${encodeURIComponent(detail.report.id)}/retry`, { method: 'POST', body: JSON.stringify({ updatedAt: detail.report.updatedAt, ...(regenerate ? { regenerate: true } : {}) }) });
      sourceGeneration.current++;
      setSourceMaterials(value => resetInterruptedLoads(Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith(`${detail.report.id}:`)))));
      setNotice(regenerate ? '已提交重新生成，将重新采集材料并保留原统计截止时间。' : '已提交重试。'); await Promise.all([refresh(), loadDetail(detail.report.id)]);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setRetrying(false); }
  }

  return <main className="main-pane reports-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button><div className="breadcrumbs"><span>系统管理</span><span className="slash">/</span><strong>工作报告</strong></div><div className="reports-top-actions">{detail && <button className="secondary-button" onClick={closeDetail}>返回列表</button>}<button className="secondary-button" onClick={onBack}>返回对话</button></div></header>
    <div className="reports-content">
      <div className="reports-heading"><div><span className="reports-eyebrow">COCELL · REPORTS</span><h1>工作报告</h1><p>日报总结当天工作；周报汇总本周日报，并标明缺失日期。时间均为北京时间。</p></div><button className="secondary-button reports-refresh" onClick={() => void refresh()}>刷新</button></div>
      {error && <div className="reports-error" role="alert">{error}<button className="secondary-button" onClick={() => void refresh()}>重试读取</button></div>}
      {notice && <div className="reports-notice" role="status">{notice}</div>}
      {!detail && <>
        {draft && <section className="reports-settings">
          <div className="reports-section-title"><div><h2>生成设置</h2><p>定时生成报告，可按需调整提示词和模型。</p></div><button className="primary-button" disabled={saving || !dirty} onClick={() => void saveSettings()}>{saving ? '保存中…' : '保存设置'}</button></div>
          <label className="report-model">模型<input value={draft.model} onChange={event => patchSettings({ model: event.target.value, modelEntryId: undefined })} placeholder="gpt-6-luna" /></label>
          <div className="report-schedule-grid">
            <section className="report-schedule"><div className="report-schedule-title"><label><input type="checkbox" checked={draft.daily.enabled} onChange={event => patchSettings({ daily: { ...draftRef.current!.daily, enabled: event.target.checked } })} />日报</label><input aria-label="日报生成时间" type="time" value={draft.daily.time} onChange={event => patchSettings({ daily: { ...draftRef.current!.daily, time: event.target.value } })} /></div><p>{view?.nextRuns.find(run => run.kind === 'daily') ? `下次 ${dateLabel(view.nextRuns.find(run => run.kind === 'daily')!.scheduledAt)} · 当天截至生成时间` : '定时生成已关闭'}</p><textarea aria-label="日报提示词" value={draft.prompts.daily} onChange={event => patchSettings({ prompts: { ...draftRef.current!.prompts, daily: event.target.value } })} rows={5} /></section>
            <section className="report-schedule"><div className="report-schedule-title"><label><input type="checkbox" checked={draft.weekly.enabled} onChange={event => patchSettings({ weekly: { ...draftRef.current!.weekly, enabled: event.target.checked } })} />周报</label><div className="report-weekly-time"><select aria-label="周报生成星期" value={draft.weekly.weekday} onChange={event => patchSettings({ weekly: { ...draftRef.current!.weekly, weekday: Number(event.target.value) } })}>{['周一','周二','周三','周四','周五','周六','周日'].map((label, index) => <option key={label} value={index + 1}>{label}</option>)}</select><input aria-label="周报生成时间" type="time" value={draft.weekly.time} onChange={event => patchSettings({ weekly: { ...draftRef.current!.weekly, time: event.target.value } })} /></div></div><p>{view?.nextRuns.find(run => run.kind === 'weekly') ? `下次检查 ${dateLabel(view.nextRuns.find(run => run.kind === 'weekly')!.scheduledAt)} · ${draft.daily.enabled ? '周报时间为最早检查时间，等待当天定时日报完成后再汇总' : '汇总本周已完成日报，缺失日期会标明'}` : '定时生成已关闭；周报只汇总本周日报，覆盖缺口会标明'}</p><textarea aria-label="周报提示词" value={draft.prompts.weekly} onChange={event => patchSettings({ prompts: { ...draftRef.current!.prompts, weekly: event.target.value } })} rows={5} /></section>
          </div>
        </section>}
        <section className="reports-manual"><div><h2>手动生成</h2><p>统计范围：{dateRange(selectedKind, selectedDate)}（北京时间）。{selectedKind === 'weekly' ? '周报汇总所选周内已生成的日报；尚无日报的日期会标明缺失。' : '日报总结所选日期截至现在的工作。'}</p></div><select aria-label="报告类型" value={selectedKind} onChange={event => { const kind = event.target.value as ReportKind; setSelectedKind(kind); setSelectedDate(defaultDate(kind)); }}><option value="daily">日报</option><option value="weekly">周报</option></select><input aria-label="报告日期" type="date" value={selectedDate} max={dateLimit(selectedKind)} onChange={event => setSelectedDate(event.target.value)} /><button className="primary-button" disabled={generating || !selectedDate || selectedDate > dateLimit(selectedKind)} onClick={() => void generate()}>{generating ? '提交中…' : '生成报告'}</button></section>
        <section className="reports-records"><div className="reports-section-title"><div><h2>历史报告</h2><p>按周一至周日分组，最新一周在前；每周先显示周报，再按日期倒序显示日报。</p></div></div>{loading && !view ? <div className="reports-state">正在加载报告…</div> : !view?.reports.length ? <div className="reports-state">暂无报告</div> : weeks.map(week => <section className="reports-week" key={week.start} aria-labelledby={`report-week-${week.start}`}><div className="reports-week-heading"><h3 id={`report-week-${week.start}`}>{week.start} 至 {addDays(week.start, 6)}</h3><span>{week.reports.filter(report => report.kind === 'weekly').length} 份周报 · {week.reports.filter(report => report.kind === 'daily').length} 份日报</span></div><div className="reports-table-head"><span>类型与日期</span><span>状态</span><span>来源</span><span>费用</span></div>{week.reports.map(report => { const dailyInputs = dailyInputsOf(report); return <button className="reports-row" key={report.id} onClick={() => void loadDetail(report.id)}><span><strong>{kinds[report.kind]} · {reportPeriod(report)}</strong><small>{report.waitingForDaily ? `等待 ${dateOnly(report.waitingForDaily)} 日报 · ` : ''}{reportAsOf(report) ? `${snapshotLabel(report)} · 截至 ${dateLabel(reportAsOf(report))} · ` : ''}生成于 {dateLabel(report.generatedAt || report.createdAt)}</small></span><span className={`report-status report-${report.status}`}>{statusLabels[report.status]}</span><span>{dailyInputs ? `${dailyInputs.filter(item => item.status === 'included').length} 天日报` : `${report.sourceCount} 条来源`}{report.missingCount > 0 && <small className="report-missing"> · {dailyInputs ? '覆盖不完整' : '缺失'} {report.missingCount}{dailyInputs ? ' 天' : ''}</small>}</span><span>{feeLabel(report.usage.estimatedCostUsd, report.usage.unknownCalls)}</span></button>; })}</section>)}
        </section>
      </>}
      {detail && <section className="report-detail"><button className="report-back-inline" onClick={closeDetail}>← 返回报告列表</button><div className="report-detail-heading"><div><span className="reports-eyebrow">{kinds[detail.report.kind]} · {reportPeriod(detail.report)}</span><h1>{statusLabels[detail.report.status]}</h1><p>{reportAsOf(detail.report) ? `${snapshotLabel(detail.report)} · 截至 ${dateLabel(reportAsOf(detail.report))} · ` : ''}模型 {detail.report.model} · 生成于 {dateLabel(detail.report.generatedAt || detail.report.createdAt)}</p></div>{detail.report.status === 'failed' && <button className="primary-button" disabled={retrying} onClick={() => void retry()}>{retrying ? '提交中…' : '重试'}</button>}{detail.report.status === 'ready' && detail.report.missingCount > 0 && <button className="primary-button" disabled={retrying} onClick={() => void retry(true)}>{retrying ? '提交中…' : '重新采集并生成'}</button>}</div>
        {detail.report.waitingForDaily && <div className="reports-notice report-waiting-daily" role="status">等待 {dateOnly(detail.report.waitingForDaily)} 的日报完成后生成周报。</div>}
        {detail.report.error && <div className="reports-error">{detail.report.error}</div>}
        <div className="report-usage"><span>{detail.report.dailyInputs ? <>日报 {detail.report.dailyInputs.filter(item => item.status === 'included').length} 天 · 覆盖不完整 {detail.report.missingCount} 天</> : <>来源 {detail.report.sourceCount} 条 · 缺失 {detail.report.missingCount} 条{(detail.report.snapshotCount ?? 0) > 0 && ` · ${detail.report.snapshotCount} 条进行中快照`}</>} </span><span>输入 {detail.report.usage.inputTokens.toLocaleString()} tokens · 缓存输入 {detail.report.usage.cachedInputTokens.toLocaleString()} tokens · 输出 {detail.report.usage.outputTokens.toLocaleString()} tokens</span><span>{feeLabel(detail.report.usage.estimatedCostUsd, detail.report.usage.unknownCalls)}{detail.report.usage.unknownCalls > 0 && ` · ${detail.report.usage.unknownCalls} 次调用用量未知`}</span><small>费用按本次实际发起的调用估算；缓存复用不重复计入历史费用。</small></div>
        <div className="report-body">{detail.body ? <Markdown text={detail.body} /> : <div className="reports-state">{active.has(detail.report.status) ? '报告生成中…' : '暂无报告正文'}</div>}</div>
        {detail.report.dailyInputs ? <><h2 className="report-sources-title">来源日报 · {detail.report.dailyInputs.length} 天</h2><div className="report-sources report-daily-inputs">{detail.report.dailyInputs.map((daily, index) => <article key={`${daily.date}-${index}`}><div><strong>{daily.date} · {daily.status === 'included' ? '已纳入日报' : daily.status === 'missing' ? '日报缺失' : daily.status === 'failed' ? '日报生成失败' : '日报待完成'}</strong><small>{daily.status === 'included' ? daily.asOf ? `日报截至 ${dateLabel(daily.asOf)}` : '完整日报' : daily.asOf ? `日报截至 ${dateLabel(daily.asOf)}` : '本周此日尚无可用日报'}{(daily.missingCount ?? 0) > 0 ? ` · 日报覆盖不完整 ${daily.missingCount} 个来源` : ''}{(daily.snapshotCount ?? 0) > 0 ? ` · ${daily.snapshotCount} 个快照来源` : ''}</small></div>{daily.reportId && <div className="report-source-actions"><button onClick={() => void loadDetail(daily.reportId!)}>查看日报</button></div>}{daily.error && <p className="report-source-error">{daily.error}</p>}</article>)}</div></> : <><h2 className="report-sources-title">来源对话 · {detail.sources.length}</h2><div className="report-sources">{detail.sources.map((source, index) => {
          const materialKey = `${detail.report.id}:${source.sessionId}`;
          const material = sourceMaterials[materialKey];
          return <article key={`${source.sessionId}-${index}`}><div><strong>{source.projectName} · {source.sessionTitle || '未命名对话'}</strong><small>更新于 {dateLabel(source.sourceUpdatedAt)} · {source.status === 'included' ? '已纳入' : source.status === 'empty' ? '无可用材料' : '读取失败'}{source.isSnapshot ? ' · 进行中快照' : ''}{source.collectedAt ? ` · 采集于 ${dateLabel(source.collectedAt)}` : ''}</small></div><div className="report-source-actions"><a href={`/sessions/${encodeURIComponent(source.sessionId)}`} target="_blank" rel="noreferrer">打开对话 ↗</a><button onClick={() => void toggleSourceMaterial(source.sessionId)}>{material?.open ? '收起本次材料' : '查看本次材料'}</button></div>{source.summary && <p>{source.summary}</p>}{source.error && <p className="report-source-error">{source.error}</p>}{material?.open && <div className="report-source-material">{material.content ? <Markdown text={material.content} /> : !material.loading ? <div className="reports-state">本次来源材料为空。</div> : null}{material.loading && <div className="report-material-progress">{material.content ? '继续读取中…' : '正在读取材料…'}</div>}{material.error && <div className="reports-error" role="alert">{material.error}</div>}<div className="report-material-footer"><small>已加载 {(material.content ? utf8Bytes(material.content) : 0).toLocaleString()} / {material.totalBytes.toLocaleString()} 字节</small>{material.error && !material.content && <button disabled={material.loading} onClick={() => void loadSourceMaterial(source.sessionId, 0)}>重试加载</button>}{material.nextOffset !== null && <button disabled={material.loading} onClick={() => void loadSourceMaterial(source.sessionId, material.nextOffset!)}>{material.loading ? '加载中…' : material.error ? '重试加载' : '继续加载'}</button>}</div></div>}</article>;
        })}</div></>}
        {generationSessions.length > 0 && <div className="report-generation-session"><span>生成过程：</span>{generationSessions.map((id, index) => <a key={id} href={`/sessions/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">{detail.report.status === 'ready' && index === generationSessions.length - 1 ? '最终汇总' : `生成步骤 ${index + 1}`} ↗</a>)}</div>}
      </section>}
    </div>
  </main>;
}
