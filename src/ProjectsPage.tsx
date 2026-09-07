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
  onDeleted: (id: string) => void;
};
const states = { starting: '启动中', ready: '运行中', paused: '已暂停', unavailable: '不可用' };
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
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
function ProjectCard({ project, onRefresh, onOpenProject, onDeleted }: Pick<Props, 'onRefresh' | 'onOpenProject' | 'onDeleted'> & { project: ProjectSummary }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmDelete) cancelDelete.current?.focus(); }, [confirmDelete]);
  const stopEditing = () => { setEditing(false); setTimeout(() => editButton.current?.focus(), 0); };
  const stopDeleting = () => { setConfirmDelete(false); setTimeout(() => deleteButton.current?.focus(), 0); };
  return <article className="project-card" aria-label={project.name}>
    <div className="project-card-heading"><span className="project-folder" aria-hidden="true">▱</span><span className={`project-status ${project.activeSessionId ? 'active' : ''}`}>{project.activeSessionId ? '任务执行中' : project.sandbox ? states[project.sandbox.status] : project.executionMode === 'local' ? '本地项目' : '等待首次执行'}</span></div>
    <h2><button className="project-title-button" onClick={() => onOpenProject(project.id)}>{project.name}</button></h2>
    {project.requirementUrl && /^https?:\/\//i.test(project.requirementUrl) ? <a className="project-requirement" href={project.requirementUrl} target="_blank" rel="noopener noreferrer" title={project.requirementUrl}>飞书需求 ↗<span>{project.requirementUrl}</span></a> : <p className="project-unlinked">暂未关联飞书需求</p>}
    <dl className="project-details"><div><dt>会话</dt><dd>{project.sessionCount} 个</dd></div><div><dt>沙箱</dt><dd>{project.sandbox ? <code title={project.sandbox.id}>{project.sandbox.id}</code> : project.executionMode === 'local' ? '本地运行' : '首次执行任务时创建'}</dd></div><div><dt>更新</dt><dd><time dateTime={project.updatedAt}>{date(project.updatedAt)}</time></dd></div></dl>
    {editing ? <ProjectForm initial={project} busy={busy} onCancel={stopEditing} onSubmit={async values => {
      setBusy(true);
      try { await mutate(`/api/projects/${encodeURIComponent(project.id)}`, 'PATCH', values); await onRefresh(); stopEditing(); }
      finally { setBusy(false); }
    }} /> : <div className="project-card-actions"><button className="primary-button" onClick={() => onOpenProject(project.id)}>进入项目 <span aria-hidden="true">→</span></button><button ref={editButton} className="secondary-button" onClick={() => { setEditing(true); setConfirmDelete(false); setError(''); }} disabled={busy}>编辑</button><button ref={deleteButton} className="project-delete-button" disabled={busy || !!project.activeSessionId} title={project.activeSessionId ? '请等待项目内任务结束后再删除' : '删除项目'} onClick={() => { setConfirmDelete(true); setError(''); }}>删除</button></div>}
    {confirmDelete && <div className="project-delete-confirm" role="group" aria-label={`确认删除项目 ${project.name}`} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); stopDeleting(); } }}>
      <strong>删除「{project.name}」？</strong><p>将删除项目内全部 {project.sessionCount} 个会话及其历史，并销毁项目沙箱和其中所有文件。此操作无法撤销。</p>
      {project.activeSessionId && <p>项目内有任务正在执行，请等待结束后再删除。</p>}
      <div><button ref={cancelDelete} className="secondary-button" disabled={busy} onClick={stopDeleting}>保留项目</button><button className="project-danger-button" disabled={busy || !!project.activeSessionId} onClick={async () => {
        setBusy(true); setError('');
        try { await mutate(`/api/projects/${encodeURIComponent(project.id)}`, 'DELETE'); onDeleted(project.id); await onRefresh(); }
        catch (err) { setError(err instanceof Error ? err.message : '删除失败，请重试。'); }
        finally { setBusy(false); }
      }}>{busy ? '删除中…' : '确认删除项目与全部数据'}</button></div>
    </div>}
    {error && <p className="project-error" role="alert">{error}</p>}
  </article>;
}
export default function ProjectsPage({ projects, config, loading, onRefresh, onOpenProject, onMenu, onBack, onDeleted }: Props) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const createButton = useRef<HTMLButtonElement>(null);
  const visible = projects.filter(project => `${project.name} ${project.requirementUrl ?? ''} ${project.sandbox?.id ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const canCreate = config?.e2b?.enabled === true;
  const stopCreating = () => { setCreating(false); setTimeout(() => createButton.current?.focus(), 0); };
  return <main className="main-pane projects-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>项目</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="projects-scroll"><div className="projects-heading"><div><span className="projects-eyebrow">PROJECT WORKSPACE</span><h1>项目</h1><p>一个项目，一个独立沙箱。通过多个会话协作完成需求。</p></div><button ref={createButton} className="primary-button" disabled={!canCreate || creating} onClick={() => setCreating(true)}>＋ 创建项目</button></div>
      {!config ? <p className="project-notice" role="status">正在读取项目配置…</p> : !canCreate && <p className="project-notice">创建项目需要先在服务端配置 E2B 连接。已有项目仍可查看。</p>}
      {error && <p className="project-error project-page-error" role="alert">{error}</p>}
      {creating && canCreate && <section className="project-create-panel"><h2>创建项目</h2><ProjectForm busy={busy} onCancel={stopCreating} onSubmit={async values => {
        setBusy(true);
        try { const project = await mutate('/api/projects', 'POST', values); stopCreating(); await onRefresh(); onOpenProject(project.id); }
        finally { setBusy(false); }
      }} /></section>}
      <div className="projects-toolbar"><h2>全部项目 <span>{projects.length}</span></h2><div><input aria-label="搜索项目" placeholder="搜索项目、需求链接或沙箱" value={query} onChange={event => setQuery(event.target.value)} /><button className="secondary-button" disabled={loading} onClick={async () => { setError(''); try { await onRefresh(); } catch (err) { setError(err instanceof Error ? err.message : '刷新失败，请重试。'); } }}>{loading ? '刷新中…' : '刷新'}</button></div></div>
      <section className="project-grid" aria-label="项目列表" aria-busy={loading}>
        {!projects.length && loading ? <div className="projects-empty" role="status"><span className="spinner" /> 正在读取项目…</div> : !visible.length ? <div className="projects-empty"><span aria-hidden="true">▱</span><h2>{projects.length ? '没有匹配的项目' : '从一个项目开始'}</h2><p>{projects.length ? '试试其他项目名称、需求链接或沙箱 ID。' : '先创建项目，再开启会话。飞书需求可以稍后关联。'}</p>{!projects.length && canCreate && !creating && <button className="primary-button" onClick={() => setCreating(true)}>创建第一个项目</button>}</div> : visible.map(project => <ProjectCard key={project.id} project={project} onRefresh={onRefresh} onOpenProject={onOpenProject} onDeleted={onDeleted} />)}
      </section>
    </div>
  </main>;
}
