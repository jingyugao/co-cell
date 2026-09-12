import { useEffect, useRef, useState } from 'react';
import type { SandboxInventory, SandboxRecord } from '../../../protocol/types';
import { api } from '../../lib/api';
import './SandboxManager.css';

const states = { running: '运行中', paused: '已暂停', archiving: '归档中', archived: '已归档', restoring: '恢复中', unknown: '未知' };
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function bytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  return `${(value / 1024 ** 2).toFixed(0)} MiB`;
}
function Meter({ value }: { value: number | null }) {
  return <span className="sandbox-meter" aria-hidden="true"><span style={{ width: `${value == null ? 0 : Math.max(0, Math.min(100, value))}%` }} /></span>;
}
function Resources({ sandbox, kind }: { sandbox: SandboxRecord; kind: 'cpu' | 'memory' | 'disk' }) {
  const metrics = sandbox.metricsStatus === 'available' ? sandbox.metrics : null;
  const value = kind === 'cpu' ? metrics?.cpuUsedPct ?? null : kind === 'memory' ? metrics?.memUsedBytes ?? null : metrics?.diskUsedBytes ?? null;
  const total = kind === 'memory' ? metrics?.memTotalBytes : metrics?.diskTotalBytes;
  const percent = kind === 'cpu' ? value : value != null && total ? value / total * 100 : null;
  return <div className="sandbox-resource">
    <strong>{value == null ? '—' : kind === 'cpu' ? `${value.toFixed(1)}%` : bytes(value)}</strong>
    <Meter value={percent} />
    <small>{kind === 'cpu' ? sandbox.cpuCount ? `配置 ${sandbox.cpuCount} vCPU` : '未分配运行资源' : kind === 'memory' ? sandbox.memoryMB ? `配置 ${bytes(sandbox.memoryMB * 1024 ** 2)}` : '未分配运行资源' : total == null ? '容量未上报' : `共 ${bytes(total)}`}</small>
  </div>;
}
function CleanupStatus({ sandbox }: { sandbox: SandboxRecord }) {
  if (!sandbox.dangling) return null;
  const cleanup = sandbox.cleanup;
  if (!cleanup) return <small className="sandbox-cleanup-note unknown">来源不明，不会自动清理。确认无用后可手动删除。</small>;
  const reason = cleanup.reason === 'upgrade' ? '升级后的旧环境' : cleanup.reason === 'idle' ? '闲置回收环境' : '复原失败产生的环境';
  const retentionHours = Math.max(0, Math.round((Date.parse(cleanup.deleteAfter) - Date.parse(cleanup.scheduledAt)) / (60 * 60 * 1000)));
  return <small className={`sandbox-cleanup-note ${cleanup.lastError ? 'failed' : ''}`} title={cleanup.lastError}>
    {cleanup.lastError ? <>自动清理失败（已尝试 {cleanup.attempts} 次），后台会重试，也可手动删除。<br />原计划于 {date(cleanup.deleteAfter)} 删除</> : <>{reason}{retentionHours > 0 && <> · 保留 {retentionHours} 小时</>}<br />计划于 {date(cleanup.deleteAfter)} 自动删除</>}
  </small>;
}

export default function SandboxManager({ onOpenSession, onOpenProject, onMenu, onBack }: { onOpenProject: (id: string) => void; onOpenSession: (id: string) => void; onMenu: () => void; onBack: () => void }) {
  const [data, setData] = useState<SandboxInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [state, setState] = useState('all');
  const [refresh, setRefresh] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    let alive = true;
    async function load() {
      if (request.current) return;
      const controller = new AbortController(); request.current = controller; setLoading(true);
      const timeout = setTimeout(() => controller.abort(), 45_000);
      try {
        const response = await fetch('/api/sandboxes', { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `读取失败 (${response.status})`);
        if (alive) { setData(body); setError(''); }
      } catch (err) {
        if (alive) setError(controller.signal.aborted ? '读取超时，请重试。' : err instanceof Error ? err.message : '无法读取沙箱列表');
      } finally { clearTimeout(timeout); if (request.current === controller) request.current = null; if (alive) setLoading(false); }
    }
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { alive = false; clearInterval(timer); request.current?.abort(); request.current = null; };
  }, [refresh]);
  const sandboxes = data?.sandboxes ?? [];
  const running = sandboxes.filter(box => box.state === 'running');
  const paused = sandboxes.filter(box => box.state === 'paused').length;
  const archived = sandboxes.filter(box => box.state === 'archived').length;
  const dangling = sandboxes.filter(box => box.dangling === true).length;
  const visible = sandboxes.filter(box => (state === 'all' || box.state === state) && `${box.id} ${box.template} ${box.project?.name ?? ''} ${box.project?.requirementUrl ?? ''} ${(box.sessions ?? (box.session ? [box.session] : [])).map(session => session.title + ' ' + session.id).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  async function deleteSandbox(id: string) {
    if (confirmDelete !== id || deleting) return;
    setDeleting(id); setError('');
    try {
      await api<unknown>(`/api/sandboxes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setConfirmDelete(null);
      setData(current => current ? { ...current, sandboxes: current.sandboxes.filter(item => item.id !== id) } : current);
      setRefresh(value => value + 1);
    } catch (err) {
      setError(`删除沙箱失败：${err instanceof Error ? err.message : '请重试。'}`);
    } finally { setDeleting(null); }
  }
  return <main className="main-pane sandbox-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>沙箱管理</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="sandbox-scroll">
      <div className="sandbox-heading"><div><span className="sandbox-eyebrow">E2B INFRASTRUCTURE</span><h1>沙箱管理</h1><p>查看当前 E2B 连接下可见的全部沙箱、资源用量和自动清理计划。</p></div><button className="primary-button sandbox-refresh" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? <><span className="spinner" />读取中…</> : '刷新列表'}</button></div>
      {error && <div className="sandbox-warning" role="alert">{error}{data && ' 下方保留上次成功读取的数据。'}</div>}
      {data?.enabled === false ? <div className="sandbox-empty"><h2>尚未配置 E2B</h2><p>配置服务端 E2B 连接后，即可查看沙箱和资源用量。</p></div> : <>
        <div className="sandbox-stats">
          <div><span>全部沙箱</span><strong>{data ? sandboxes.length : '—'}</strong><small>{data ? `${paused} 个已暂停 · ${archived} 个已归档 · ${dangling} 个悬挂` : '等待读取'}</small></div>
          <div><span>运行中</span><strong>{data ? running.length : '—'}<i className="sandbox-live-dot" /></strong><small>当前处于运行状态</small></div>
          <div><span>运行中 CPU 配额</span><strong>{data ? running.reduce((n, box) => n + box.cpuCount, 0) : '—'}<em>vCPU</em></strong><small>运行中沙箱的配置合计</small></div>
          <div><span>运行中内存配额</span><strong>{data ? bytes(running.reduce((n, box) => n + box.memoryMB, 0) * 1024 ** 2) : '—'}</strong><small>实际用量见下方采样</small></div>
        </div>
        <section className="sandbox-list" aria-label="沙箱列表" aria-busy={loading}>
          <div className="sandbox-list-toolbar"><div><h2>沙箱列表 <span>{visible.length}</span></h2><p>{data ? `更新于 ${date(data.fetchedAt)} · 每 15 秒自动刷新` : '正在连接 E2B…'}</p></div><div className="sandbox-filters"><input aria-label="搜索沙箱" placeholder="搜索 ID、项目或会话" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="筛选沙箱状态" value={state} onChange={event => setState(event.target.value)}><option value="all">全部状态</option>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
          {loading && !data ? <div className="sandbox-empty" role="status"><span className="spinner" /> 正在读取沙箱与资源指标…</div> : !data ? <div className="sandbox-empty">暂时无法读取沙箱，请点击刷新重试。</div> : !visible.length ? <div className="sandbox-empty">{sandboxes.length ? '没有匹配的沙箱，试试其他关键词或状态。' : '当前没有沙箱。首次执行 E2B 任务时会自动创建。'}</div> : <div className="sandbox-table-scroll"><table className="sandbox-table"><thead><tr><th scope="col">沙箱 / 所属项目</th><th scope="col">状态</th><th scope="col">CPU 用量</th><th scope="col">内存用量</th><th scope="col">磁盘用量</th><th scope="col">时间</th><th scope="col">操作</th></tr></thead><tbody>{visible.map(box => <tr key={box.id}>
            <td><code className="sandbox-id">{box.id}</code><span className="sandbox-template">模板 · {box.template}</span>{box.project ? <><button className="sandbox-session" title={box.project.name} onClick={() => onOpenProject(box.project!.id)}>{box.project.name} ↗</button><span className="sandbox-template">{box.project.sessionCount} 个会话 · 共享此沙箱</span>{(box.sessions ?? []).length > 0 && <details className="sandbox-project-sessions"><summary>查看会话</summary>{box.sessions!.map(session => <button key={session.id} className="sandbox-session" onClick={() => onOpenSession(session.id)}>{session.title} ↗</button>)}</details>}</> : box.session ? <button className="sandbox-session" title={box.session.title} onClick={() => onOpenSession(box.session!.id)}>{box.session.title} ↗</button> : box.dangling === true ? <><span className="sandbox-dangling">悬挂沙箱 · 未关联项目</span><CleanupStatus sandbox={box} /></> : <span className="sandbox-unlinked">未关联本应用项目</span>}</td>
            <td><span className={`sandbox-state ${box.state}`}><i />{states[box.state] ?? '未知'}</span><small className="sandbox-metric-note" title={box.metricsMessage}>{['archived', 'archiving', 'restoring'].includes(box.state) ? '无实时采样' : box.metricsStatus === 'available' && box.metrics ? `采样 ${date(box.metrics.timestamp)}` : box.metricsStatus === 'paused' ? '暂停中，无实时采样' : box.metricsStatus === 'pending' ? '等待指标采样' : '指标暂不可用'}</small>{box.metricsMessage && <small className="sandbox-metric-note">{box.metricsMessage}</small>}</td>
            <td><Resources sandbox={box} kind="cpu" /></td><td><Resources sandbox={box} kind="memory" /></td><td><Resources sandbox={box} kind="disk" /></td>
            <td className="sandbox-times">{box.startedAt && <><span>启动于</span><time dateTime={box.startedAt}>{date(box.startedAt)}</time></>}{box.endAt && box.state === 'running' && <><span>预计暂停</span><time dateTime={box.endAt}>{date(box.endAt)}</time></>}{box.pausedAt && <><span>暂停于</span><time dateTime={box.pausedAt}>{date(box.pausedAt)}</time></>}{box.archive && <><span>归档于 · {bytes(box.archive.sizeBytes)}</span><time dateTime={box.archive.createdAt}>{date(box.archive.createdAt)}</time></>}</td>
            <td className="sandbox-actions">{box.dangling === true ? confirmDelete === box.id ? <div className="sandbox-delete-confirm" role="group" aria-label={`确认删除悬挂沙箱 ${box.id}`}><p>物理删除沙箱及其中全部文件，删除后无法恢复。</p><button className="secondary-button" disabled={deleting === box.id} onClick={() => setConfirmDelete(null)}>取消</button><button className="sandbox-danger-button" disabled={Boolean(deleting)} onClick={() => void deleteSandbox(box.id)}>{deleting === box.id ? '删除中…' : '确认删除'}</button></div> : <button className="sandbox-delete-button" disabled={Boolean(deleting)} onClick={() => setConfirmDelete(box.id)}>物理删除</button> : <span>—</span>}</td>
          </tr>)}</tbody></table></div>}
          <div className="sandbox-footnote"><span className="sandbox-mobile-hint">左右滑动表格查看资源用量。<br /></span>有清理计划的悬挂沙箱会在保留期结束后自动删除；来源不明的悬挂沙箱不会自动清理。也可确认后手动物理删除。</div>
        </section>
      </>}
    </div>
  </main>;
}
