import { useEffect, useRef, useState } from 'react';
import type { AppConfig, ProjectSummary, ProjectType } from '../../../protocol/types';
import { projectDisplayName, projectTypeLabel } from '../../../util/project-types';
import type { ProjectValues, ProjectUpdate } from './useProjects';
import { groupArchivedProjectsByWeek } from './project-groups';
import './ProjectsPage.css';

type Props = {
  projects: ProjectSummary[];
  config: AppConfig | null;
  loading: boolean;
  onRefresh: () => Promise<unknown>;
  onCreate: (values: ProjectValues) => Promise<ProjectSummary>;
  onUpdate: (id: string, values: ProjectUpdate) => Promise<ProjectSummary>;
  onRebuildSandbox: (id: string) => Promise<ProjectSummary>;
  onOpenProject: (id: string) => void;
  onMenu: () => void;
  onBack: () => void;
};

const states = { starting: '启动中', ready: '运行中', paused: '已暂停', unavailable: '不可用' };
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
const DAY = 24 * 60 * 60 * 1000;
const duration = (value: number | undefined, fallback: string) => value == null ? fallback : value % DAY === 0 ? `${value / DAY} 天` : value % (60 * 60 * 1000) === 0 ? `${value / (60 * 60 * 1000)} 小时` : fallback;

function ProjectForm({ initial, busy, onSubmit, onCancel }: {
  initial?: ProjectSummary;
  busy: boolean;
  onSubmit: (values: ProjectValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.requirementUrl ?? '');
  const [type, setType] = useState<ProjectType>(initial?.type ?? (initial?.requirementUrl ? 2 : 1));
  const [error, setError] = useState('');
  const feishu = type === 2;
  const automaticName = !initial && feishu;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return <form className="project-form" aria-label={initial ? `编辑项目 ${initial.name}` : '创建项目'} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); }
  }} onSubmit={async event => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!feishu && !trimmedName) { setError('请输入项目名称。'); input.current?.focus(); return; }
    if (feishu && !url.trim()) { setError('飞书项目必须绑定飞书需求。'); return; }
    if (feishu && url.trim()) {
      try { const parsed = new URL(url.trim()); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(); }
      catch { setError('请输入有效的 HTTP 或 HTTPS 需求链接。'); return; }
    }
    setError('');
    try { await onSubmit({ name: automaticName ? '' : trimmedName, requirementUrl: feishu ? url.trim() : null, type }); }
    catch (err) { setError(err instanceof Error ? err.message : '保存失败，请重试。'); }
  }}>
    <label>项目类型<select value={type} disabled={busy || Boolean(initial)} onChange={event => { const next = Number(event.target.value) as ProjectType; setType(next); if (!initial && next === 3 && !name.trim()) setName('本周项目'); }}><option value={1}>普通项目</option><option value={2}>飞书项目</option><option value={3}>本周项目</option></select>{initial && <span>项目类型创建后不可修改</span>}</label>
    <label>项目名称<input ref={input} required={!automaticName} maxLength={100} value={automaticName ? '' : name} disabled={busy || automaticName} placeholder={automaticName ? '自动使用飞书需求名称' : type === 3 ? '例如：本周重点事项' : '例如：订单系统改造'} onChange={event => setName(event.target.value)} /></label>
    {feishu && <label>飞书需求链接<input type="url" required maxLength={4096} value={url} disabled={busy} placeholder="https://…" onChange={event => setUrl(event.target.value)} /></label>}
    {!initial && <p className="project-form-hint">飞书项目自动读取需求名称；本周项目每周只能创建一个，下一周会自动显示为上周项目。项目内会话共享一个 Sandbox，首次执行任务时创建。</p>}
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="project-form-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? automaticName ? '正在读取飞书需求并创建…' : '保存中…' : initial ? '保存修改' : '创建并进入'}</button></div>
  </form>;
}

function ProjectCard({ project, onUpdate, onRebuildSandbox, onOpenProject, onStatus }: Pick<Props, 'onUpdate' | 'onRebuildSandbox' | 'onOpenProject'> & {
  project: ProjectSummary;
  onStatus: (name: string, status: 'active' | 'completed') => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState('');
  const editButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const status = project.status ?? (project.archivedAt ? 'archived' : 'active');
  const archived = status === 'archived';
  const typeLabel = projectTypeLabel(project.type, project.weekOf);
  const displayName = projectDisplayName(project);
  const completed = status === 'completed';
  const needsRebuild = archived && project.executionMode === 'sandbox' && !project.sandbox;
  const canRebuild = needsRebuild && !project.sandbox && !project.activeSessionId;
  const stopEditing = () => { setEditing(false); setTimeout(() => editButton.current?.focus(), 0); };

  async function changeStatus() {
    if (pending.current || busy || rebuilding || (archived && needsRebuild)) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const next = completed ? 'active' : 'completed';
      await onUpdate(project.id, { status: next });
      onStatus(project.name, next);
    } catch (err) {
      const detail = err instanceof Error ? err.message : '请重试。';
      setError(`${completed ? '恢复项目' : '完成项目'}失败：${detail}`);
    } finally { pending.current = false; setBusy(false); }
  }

  async function rebuildSandbox() {
    if (!canRebuild || rebuilding) return;
    setRebuilding(true); setError('');
    try { await onRebuildSandbox(project.id); }
    catch (err) { setError(`重建 Sandbox 失败：${err instanceof Error ? err.message : '请重试。'}`); }
    finally { setRebuilding(false); }
  }

  const openDisabled = needsRebuild || completed;
  const sandboxDescription = project.sandbox ? <code title={project.sandbox.id}>{project.sandbox.id}</code>
    : archived ? '已归档，需先重建'
    : project.executionMode === 'local' ? '本地运行' : '首次执行任务时创建';

  return <article className={`project-card ${archived ? 'archived' : ''}`} aria-label={displayName}>
    <div className="project-card-heading"><span className="project-folder" aria-hidden="true">▱</span><div className="project-card-statuses"><span className="project-type-badge">{typeLabel}</span>{archived && <span className="project-archived-badge">已归档</span>}<span className={`project-status ${project.activeSessionId ? 'active' : ''}`}>{project.activeSessionId ? '任务执行中' : project.sandbox ? states[project.sandbox.status] : archived ? '无 Sandbox' : project.executionMode === 'local' ? '本地项目' : '等待首次执行'}</span></div></div>
    <h2>{openDisabled ? <span className="project-title-disabled">{displayName}</span> : <button className="project-title-button" onClick={() => onOpenProject(project.id)}>{displayName}</button>}</h2>
    {project.requirementUrl && /^https?:\/\//i.test(project.requirementUrl) ? <div className="project-requirement-wrap"><a className="project-requirement" href={project.requirementUrl} target="_blank" rel="noopener noreferrer" title={project.requirementUrl}>飞书需求 ↗<span>{project.requirementUrl}</span></a>{project.requirementStatus && <p className="project-requirement-status"><span>飞书项目状态</span><strong>{project.requirementStatus}</strong></p>}</div> : project.type === 2 ? <p className="project-unlinked">飞书需求待绑定</p> : <p className="project-unlinked">{typeLabel}</p>}
    <dl className="project-details"><div><dt>会话</dt><dd>{project.sessionCount} 个</dd></div><div><dt>Sandbox</dt><dd>{sandboxDescription}</dd></div><div><dt>开始时间</dt><dd><time dateTime={project.createdAt}>{date(project.createdAt)}</time></dd></div><div><dt>归档时间</dt><dd>{project.archivedAt ? <time dateTime={project.archivedAt}>{date(project.archivedAt)}</time> : '尚未归档'}</dd></div></dl>
    {editing ? <ProjectForm initial={project} busy={busy} onCancel={stopEditing} onSubmit={async values => {
      setBusy(true);
      try { await onUpdate(project.id, values); stopEditing(); }
      finally { setBusy(false); }
    }} /> : <div className="project-card-actions">
      {needsRebuild
        ? <button className="primary-button" disabled={!canRebuild || rebuilding} onClick={() => void rebuildSandbox()}>{rebuilding ? '正在重建…' : '重建 Sandbox'}</button>
        : <button className="primary-button" disabled={openDisabled} onClick={() => onOpenProject(project.id)}>进入项目 <span aria-hidden="true">→</span></button>}
      <button ref={editButton} className="secondary-button" onClick={() => { setEditing(true); setError(''); }} disabled={busy || rebuilding}>编辑</button>
      {!archived && <button className="project-archive-button" disabled={busy || rebuilding} title={completed ? '恢复为使用中，才能继续对话' : '完成满 1 天后自动归档并删除 Sandbox'} onClick={() => void changeStatus()}>{busy ? '处理中…' : completed ? '恢复使用中' : '标记已完成'}</button>}
    </div>}
    {needsRebuild && <p className="project-rebuild-hint">旧 Sandbox 已回收。重建成功后，项目会恢复到进行中列表。</p>}
    {error && <p className="project-error" role="alert">{error}</p>}
  </article>;
}

function ArchivedProjectRow({ project, onUpdate, onRebuildSandbox, onOpenProject, onRestored }: Pick<Props, 'onUpdate' | 'onRebuildSandbox' | 'onOpenProject'> & {
  project: ProjectSummary;
  onRestored: (name: string) => void;
}) {
  const [request, setRequest] = useState<'rebuild' | 'restore' | null>(null);
  const [error, setError] = useState('');
  // Archived projects are never entered directly. They must go through the
  // explicit sandbox rebuild flow so the user controls when a new container is
  // created, even if a stale persisted sandbox reference still exists.
  const needsRebuild = project.executionMode === 'sandbox';
  const canRebuild = needsRebuild && !project.sandbox && !project.activeSessionId;
  const status = project.activeSessionId ? '任务执行中' : project.sandbox ? '数据异常：仍有关联 Sandbox'
    : needsRebuild ? '无 Sandbox' : project.executionMode === 'local' ? '本地项目' : '等待首次执行';

  async function rebuild() {
    if (!canRebuild || request) return;
    setRequest('rebuild'); setError('');
    try { await onRebuildSandbox(project.id); }
    catch (err) { setError(`重建 Sandbox 失败：${err instanceof Error ? err.message : '请重试。'}`); }
    finally { setRequest(null); }
  }

  async function restore() {
    if (needsRebuild || request) return;
    setRequest('restore'); setError('');
    try { await onUpdate(project.id, { status: 'active' }); onRestored(project.name); }
    catch (err) { setError(`恢复项目失败：${err instanceof Error ? err.message : '请重试。'}`); }
    finally { setRequest(null); }
  }

  return <article className="archived-project-row" role="listitem" aria-label={project.name}>
    <div className="archived-project-main">
      <div className="archived-project-name">
        {needsRebuild ? <strong>{project.name}</strong> : <button onClick={() => onOpenProject(project.id)}>{project.name}</button>}
        <span>{project.requirementStatus || project.requirementUrl || '未关联需求'}</span>
      </div>
      <div className="archived-project-meta"><span>{project.sessionCount} 个会话</span><time dateTime={project.archivedAt ?? undefined}>{project.archivedAt ? date(project.archivedAt) : '时间未知'}</time></div>
      <span className="project-status">{status}</span>
      <div className="archived-project-actions">
        {needsRebuild
          ? <button className="primary-button" disabled={!canRebuild || Boolean(request)} onClick={() => void rebuild()}>{request === 'rebuild' ? '正在重建…' : '重建 Sandbox'}</button>
          : <button className="secondary-button" disabled={Boolean(request)} onClick={() => onOpenProject(project.id)}>进入</button>}
        <button className="project-archive-button" disabled={needsRebuild || Boolean(request)} title={needsRebuild ? '请先重建 Sandbox' : '恢复到进行中项目'} onClick={() => void restore()}>{request === 'restore' ? '恢复中…' : '恢复项目'}</button>
      </div>
    </div>
    {needsRebuild && <p>归档项目没有 Sandbox；重建会创建一个全新的空 Docker 环境。</p>}
    {error && <p className="project-error" role="alert">{error}</p>}
  </article>;
}

export default function ProjectsPage({ projects, config, loading, onRefresh, onCreate, onUpdate, onRebuildSandbox, onOpenProject, onMenu, onBack }: Props) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'active' | 'completed' | 'archived'>('active');
  const currentView = useRef(view); currentView.current = view;
  const [message, setMessage] = useState('');
  const activeTab = useRef<HTMLButtonElement>(null);
  const archivedTab = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState('');
  const createButton = useRef<HTMLButtonElement>(null);
  const projectStatus = (project: ProjectSummary) => project.status ?? (project.archivedAt ? 'archived' : 'active');
  const activeCount = projects.filter(project => projectStatus(project) === 'active').length;
  const completedCount = projects.filter(project => projectStatus(project) === 'completed').length;
  const archivedCount = projects.filter(project => projectStatus(project) === 'archived').length;
  const inView = projects.filter(project => projectStatus(project) === view);
  const visible = inView.filter(project => `${project.name} ${project.requirementUrl ?? ''} ${project.sandbox?.id ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const archivedGroups = view === 'archived' ? groupArchivedProjectsByWeek(visible) : [];
  const canCreate = config?.sandbox?.enabled === true;
  const stopCreating = () => { setCreating(false); setTimeout(() => createButton.current?.focus(), 0); };
  const card = (project: ProjectSummary) => <ProjectCard key={project.id} project={project} onUpdate={onUpdate} onRebuildSandbox={onRebuildSandbox} onOpenProject={onOpenProject} onStatus={(name, status) => {
    setMessage(status === 'completed' ? `「${name}」已标记完成；满 1 天后会自动归档并删除 Sandbox。` : `「${name}」已恢复为使用中。`);
    activeTab.current?.focus();
  }} />;
  const archivedRow = (project: ProjectSummary) => <ArchivedProjectRow key={project.id} project={project} onUpdate={onUpdate} onRebuildSandbox={onRebuildSandbox} onOpenProject={onOpenProject} onRestored={name => {
    setMessage(`「${name}」已恢复到进行中项目。`);
    archivedTab.current?.focus();
  }} />;

  const empty = <div className="projects-empty"><span aria-hidden="true">▱</span><h2>{query.trim() && inView.length ? '没有匹配的项目' : view === 'archived' ? '还没有归档项目' : view === 'completed' ? '还没有已完成项目' : projects.length ? '暂无使用中的项目' : '从一个项目开始'}</h2><p>{query.trim() && inView.length ? '试试其他项目名称、需求链接或 Sandbox ID。' : view === 'archived' ? '归档项目会按周显示；重建时创建全新的空 Docker Sandbox。' : view === 'completed' ? '已完成项目不能继续对话；恢复为使用中后才可继续。' : '先创建项目，再开启会话。飞书需求可以稍后关联。'}</p>{view === 'active' && !inView.length && canCreate && !creating && <button className="primary-button" onClick={() => setCreating(true)}>{projects.length ? '创建项目' : '创建第一个项目'}</button>}</div>;

  return <main className="main-pane projects-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>项目</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="projects-scroll"><div className="projects-heading"><div><span className="projects-eyebrow">PROJECT WORKSPACE</span><h1>项目</h1><p>项目标记为已完成满 {duration(config?.sandbox?.archivedReclaimAfterMs, '1 天')} 后自动归档并删除 Sandbox；重建会创建全新的空 Docker 环境。</p></div><button ref={createButton} className="primary-button" disabled={!canCreate || creating} onClick={() => setCreating(true)}>＋ 创建项目</button></div>
      {!config ? <p className="project-notice" role="status">正在读取项目配置…</p> : !canCreate && <p className="project-notice">创建项目需要先在服务端配置 Docker sandbox。已有项目仍可查看。</p>}
      {error && <p className="project-error project-page-error" role="alert">{error}</p>}
      {message && <p className="project-message" role="status">{message}</p>}
      {creating && canCreate && <section className="project-create-panel"><h2>创建项目</h2><ProjectForm busy={busy} onCancel={stopCreating} onSubmit={async values => {
        setBusy(true);
        try { const project = await onCreate(values); stopCreating(); setView('active'); onOpenProject(project.id); }
        finally { setBusy(false); }
      }} /></section>}
      <div className="projects-toolbar"><div className="project-tabs" role="group" aria-label="项目状态"><button ref={activeTab} className={view === 'active' ? 'selected' : ''} aria-pressed={view === 'active'} onClick={() => setView('active')}>使用中 <span>{activeCount}</span></button><button className={view === 'completed' ? 'selected' : ''} aria-pressed={view === 'completed'} onClick={() => setView('completed')}>已完成 <span>{completedCount}</span></button><button ref={archivedTab} className={view === 'archived' ? 'selected' : ''} aria-pressed={view === 'archived'} onClick={() => setView('archived')}>归档 <span>{archivedCount}</span></button></div><div><input aria-label="搜索项目" placeholder="搜索项目、需求链接或 Sandbox" value={query} onChange={event => setQuery(event.target.value)} /><button className="secondary-button" disabled={loading} onClick={async () => { setError(''); try { await onRefresh(); } catch (err) { setError(err instanceof Error ? err.message : '刷新失败，请重试。'); } }}>{loading ? '刷新中…' : '刷新'}</button></div></div>
      <p className="projects-archive-hint">{view === 'archived' ? '按归档日期每周一组。恢复会创建新的 Sandbox。' : view === 'completed' ? '已完成项目必须恢复为使用中，才能继续对话。' : '可将项目标记为已完成；满 1 天后系统会归档并删除其 Sandbox。'}</p>
      {!projects.length && loading ? <section className="project-grid" aria-busy="true"><div className="projects-empty" role="status"><span className="spinner" /> 正在读取项目…</div></section>
        : !visible.length ? <section className="project-grid">{empty}</section>
        : view === 'archived' ? <div className="project-week-groups" aria-label="已归档项目列表">{archivedGroups.map(group => <section className="project-week-group" key={group.key}><h2>{group.label}<span>{group.projects.length}</span></h2><div className="archived-project-list" role="list">{group.projects.map(archivedRow)}</div></section>)}</div>
        : <section className="project-grid" aria-label={`${view === 'completed' ? '已完成' : '使用中'}项目列表`}>{visible.map(card)}</section>}
    </div>
  </main>;
}
