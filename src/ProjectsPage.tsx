import { useEffect, useRef, useState } from 'react';
import type { AppConfig, ProjectSummary } from '../shared/types';
import './ProjectsPage.css';

type Props = {
  projects: ProjectSummary[];
  config: AppConfig | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
  onOpenProject: (id: string) => void;
  onMenu: () => void;
  onBack: () => void;
};
const states = { starting: '启动中', ready: '运行中', paused: '已暂停', unavailable: '不可用' };
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
async function mutate(path: string, method: string, values?: object) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(values ? { body: JSON.stringify(values) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `操作失败 (${response.status})`);
  return body;
}
function ProjectForm({ initial, busy, onSubmit, onCancel }: {
  initial?: ProjectSummary;
  busy: boolean;
  onSubmit: (values: { name: string; requirementUrl: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.requirementUrl ?? '');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return <form className="project-form" aria-label={initial ? `编辑项目 ${initial.name}` : '创建项目'} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); }
  }} onSubmit={async event => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) { setError('请输入项目名称。'); input.current?.focus(); return; }
    if (url.trim()) {
      try { const parsed = new URL(url.trim()); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(); }
      catch { setError('请输入有效的 HTTP 或 HTTPS 需求链接。'); return; }
    }
    setError('');
    try { await onSubmit({ name: trimmedName, requirementUrl: url.trim() || null }); }
    catch (err) { setError(err instanceof Error ? err.message : '保存失败，请重试。'); }
  }}>
    <label>项目名称<input ref={input} required maxLength={100} value={name} disabled={busy} placeholder="例如：订单系统改造" onChange={event => setName(event.target.value)} /></label>
    <label>飞书需求链接 <span>选填</span><input type="url" maxLength={4096} value={url} disabled={busy} placeholder="https://…（可以暂时留空）" onChange={event => setUrl(event.target.value)} /></label>
    {!initial && <p className="project-form-hint">项目内的会话共享同一个沙箱和工作目录，各自保留对话上下文。首次执行任务时创建沙箱。</p>}
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="project-form-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : initial ? '保存修改' : '创建并进入'}</button></div>
  </form>;
}
function ProjectCard({ project, onRefresh, onOpenProject, onArchived }: Pick<Props, 'onRefresh' | 'onOpenProject'> & { project: ProjectSummary; onArchived: (name: string, archived: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const archived = Boolean(project.archivedAt);
  const stopEditing = () => { setEditing(false); setTimeout(() => editButton.current?.focus(), 0); };
  async function changeArchived() {
    if (pending.current || busy) return;
    pending.current = true; setBusy(true); setError('');
    let saved = false;
    try {
      await mutate(`/api/projects/${encodeURIComponent(project.id)}`, 'PATCH', { archived: !archived });
      saved = true;
      await onRefresh();
      onArchived(project.name, !archived);
    } catch (err) {
      const detail = err instanceof Error ? err.message : '请重试。';
      setError(saved ? `项目状态已保存，列表刷新失败：${detail}` : `${archived ? '取消归档' : '归档'}失败：${detail}`);
    } finally { pending.current = false; setBusy(false); }
  }
  return <article className={`project-card ${archived ? 'archived' : ''}`} aria-label={project.name}>
    <div className="project-card-heading"><span className="project-folder" aria-hidden="true">▱</span><div className="project-card-statuses">{archived && <span className="project-archived-badge">已归档</span>}<span className={`project-status ${project.activeSessionId ? 'active' : ''}`}>{project.activeSessionId ? '任务执行中' : project.sandbox ? states[project.sandbox.status] : project.executionMode === 'local' ? '本地项目' : '等待首次执行'}</span></div></div>
    <h2><button className="project-title-button" onClick={() => onOpenProject(project.id)}>{project.name}</button></h2>
    {project.requirementUrl && /^https?:\/\//i.test(project.requirementUrl) ? <a className="project-requirement" href={project.requirementUrl} target="_blank" rel="noopener noreferrer" title={project.requirementUrl}>飞书需求 ↗<span>{project.requirementUrl}</span></a> : <p className="project-unlinked">暂未关联飞书需求</p>}
    <dl className="project-details"><div><dt>会话</dt><dd>{project.sessionCount} 个</dd></div><div><dt>沙箱</dt><dd>{project.sandbox ? <code title={project.sandbox.id}>{project.sandbox.id}</code> : project.executionMode === 'local' ? '本地运行' : '首次执行任务时创建'}</dd></div><div><dt>开始时间</dt><dd><time dateTime={project.createdAt}>{date(project.createdAt)}</time></dd></div><div><dt>结束时间（归档）</dt><dd>{project.archivedAt ? <time dateTime={project.archivedAt}>{date(project.archivedAt)}</time> : '尚未归档'}</dd></div></dl>
    {editing ? <ProjectForm initial={project} busy={busy} onCancel={stopEditing} onSubmit={async values => {
      setBusy(true);
      try { await mutate(`/api/projects/${encodeURIComponent(project.id)}`, 'PATCH', values); await onRefresh(); stopEditing(); }
      finally { setBusy(false); }
    }} /> : <div className="project-card-actions"><button className="primary-button" onClick={() => onOpenProject(project.id)}>进入项目 <span aria-hidden="true">→</span></button><button ref={editButton} className="secondary-button" onClick={() => { setEditing(true); setError(''); }} disabled={busy}>编辑</button><button className="project-archive-button" disabled={busy} title={archived ? '移回进行中列表' : '移入已归档列表，任务和沙箱继续保留'} onClick={() => void changeArchived()}>{busy ? '处理中…' : archived ? '取消归档' : '归档'}</button></div>}
    {error && <p className="project-error" role="alert">{error}</p>}
  </article>;
}
export default function ProjectsPage({ projects, config, loading, onRefresh, onOpenProject, onMenu, onBack }: Props) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'active' | 'archived'>('active');
  const currentView = useRef(view); currentView.current = view;
  const [message, setMessage] = useState('');
  const activeTab = useRef<HTMLButtonElement>(null);
  const archivedTab = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState('');
  const createButton = useRef<HTMLButtonElement>(null);
  const activeCount = projects.filter(project => !project.archivedAt).length;
  const archivedCount = projects.length - activeCount;
  const grouped = projects.filter(project => Boolean(project.archivedAt) === (view === 'archived'));
  if (view === 'archived') grouped.sort((a, b) => (Date.parse(b.archivedAt!) || 0) - (Date.parse(a.archivedAt!) || 0));
  const visible = grouped.filter(project => `${project.name} ${project.requirementUrl ?? ''} ${project.sandbox?.id ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const canCreate = config?.e2b?.enabled === true;
  const stopCreating = () => { setCreating(false); setTimeout(() => createButton.current?.focus(), 0); };
  return <main className="main-pane projects-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>项目</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="projects-scroll"><div className="projects-heading"><div><span className="projects-eyebrow">PROJECT WORKSPACE</span><h1>项目</h1><p>一个项目，一个独立沙箱。通过多个会话协作完成需求。</p></div><button ref={createButton} className="primary-button" disabled={!canCreate || creating} onClick={() => setCreating(true)}>＋ 创建项目</button></div>
      {!config ? <p className="project-notice" role="status">正在读取项目配置…</p> : !canCreate && <p className="project-notice">创建项目需要先在服务端配置 E2B 连接。已有项目仍可查看。</p>}
      {error && <p className="project-error project-page-error" role="alert">{error}</p>}
      {message && <p className="project-message" role="status">{message}</p>}
      {creating && canCreate && <section className="project-create-panel"><h2>创建项目</h2><ProjectForm busy={busy} onCancel={stopCreating} onSubmit={async values => {
        setBusy(true);
        try { const project = await mutate('/api/projects', 'POST', values); stopCreating(); setView('active'); await onRefresh(); onOpenProject(project.id); }
        finally { setBusy(false); }
      }} /></section>}
      <div className="projects-toolbar"><div className="project-tabs" role="group" aria-label="项目状态"><button ref={activeTab} className={view === 'active' ? 'selected' : ''} aria-pressed={view === 'active'} onClick={() => setView('active')}>进行中 <span>{activeCount}</span></button><button ref={archivedTab} className={view === 'archived' ? 'selected' : ''} aria-pressed={view === 'archived'} onClick={() => setView('archived')}>已归档 <span>{archivedCount}</span></button></div><div><input aria-label="搜索项目" placeholder="搜索项目、需求链接或沙箱" value={query} onChange={event => setQuery(event.target.value)} /><button className="secondary-button" disabled={loading} onClick={async () => { setError(''); try { await onRefresh(); } catch (err) { setError(err instanceof Error ? err.message : '刷新失败，请重试。'); } }}>{loading ? '刷新中…' : '刷新'}</button></div></div>
      <p className="projects-archive-hint">{view === 'archived' ? '按归档时间从新到旧排列。结束时间记录归档时间，项目仍可进入使用，沙箱和会话保留。' : '归档将项目移入已归档列表，不停止任务。归档后仍可进入使用，也可随时取消归档。'}</p>
      <section className="project-grid" aria-label={view === 'archived' ? '已归档项目列表' : '进行中项目列表'} aria-busy={loading}>
        {!projects.length && loading ? <div className="projects-empty" role="status"><span className="spinner" /> 正在读取项目…</div> : !visible.length ? <div className="projects-empty"><span aria-hidden="true">▱</span><h2>{query.trim() && grouped.length ? '没有匹配的项目' : view === 'archived' ? '还没有归档项目' : projects.length ? '暂无进行中的项目' : '从一个项目开始'}</h2><p>{query.trim() && grouped.length ? '试试其他项目名称、需求链接或沙箱 ID。' : view === 'archived' ? '将暂时告一段落的项目归档，沙箱、会话和文件继续保留。' : projects.length ? '可以创建新项目，也可在已归档列表中继续使用原项目。' : '先创建项目，再开启会话。飞书需求可以稍后关联。'}</p>{view === 'active' && !grouped.length && canCreate && !creating && <button className="primary-button" onClick={() => setCreating(true)}>{projects.length ? '创建项目' : '创建第一个项目'}</button>}</div> : visible.map(project => <ProjectCard key={project.id} project={project} onRefresh={onRefresh} onOpenProject={onOpenProject} onArchived={(name, archived) => { setMessage(`「${name}」已${archived ? '归档，可在已归档列表中继续使用。' : '取消归档，已移回进行中列表。'}`); (currentView.current === 'archived' ? archivedTab : activeTab).current?.focus(); }} />)}
      </section>
    </div>
  </main>;
}
