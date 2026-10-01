import ImagePicker from '../images/ImagePicker';
import RestoreVersionPicker from '../images/RestoreVersionPicker';
import { useEffect, useRef, useState } from 'react';
import type { AppConfig, ProjectSummary, ProjectType } from '../../../protocol/types';
import { SandboxVersion } from '../../components/SandboxVersion';
import { projectDisplayName, projectTypeLabel } from '../../../util/project-types';
import { canEnterProject } from '../../../util/project-sandbox';
import type { ProjectValues, ProjectUpdate } from './useProjects';
import { groupArchivedProjectsByWeek } from './project-groups';
import ArchiveVersionBadge from './ArchiveVersionBadge';
import './ProjectsPage.css';

type Props = {
  projects: ProjectSummary[];
  config: AppConfig | null;
  loading: boolean;
  onRefresh: () => Promise<unknown>;
  onCreate: (values: ProjectValues) => Promise<ProjectSummary>;
  onUpdate: (id: string, values: ProjectUpdate) => Promise<ProjectSummary>;
  onRebuildSandbox: (id: string, imageVersionId?: string) => Promise<ProjectSummary>;
  onBackup: (id: string) => Promise<ProjectSummary>;
  onResumeSandbox: (id: string) => Promise<ProjectSummary>;
  onCheckpointSandbox: (id: string) => Promise<ProjectSummary>;
  onOpenProject: (id: string) => void;
  onViewBackup?: (archiveKey: string, versionId: string | undefined,
    meta: { sizeBytes: number; bytesAdded?: number; createdAt: string }) => void;
  onMenu: () => void;
  onBack: () => void;
  /** Used by the archive route and component tests; the product default is active. */
  initialView?: 'active' | 'completed' | 'archived';
};

const states = { starting: '准备中', ready: '就绪', paused: '已暂停（Checkpoint）', unavailable: '异常', unknown: '状态未知' };
const operationLabels = { create: '创建 Sandbox', checkpoint: 'Checkpoint', backup: '备份', restore: '恢复环境', resume: '恢复运行', refresh: '刷新运行环境', archive: '归档' };
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
const backupDate = (value: string) => {
  const timestamp = Date.parse(value);
  const elapsed = Date.now() - timestamp;
  return Number.isFinite(timestamp) && elapsed >= 0 && elapsed < 60 * 60 * 1000 ? `${Math.floor(elapsed / (60 * 1000))} 分前` : date(value);
};
const DAY = 24 * 60 * 60 * 1000;
const duration = (value: number | undefined, fallback: string) => value == null ? fallback : value % DAY === 0 ? `${value / DAY} 天` : value % (60 * 60 * 1000) === 0 ? `${value / (60 * 60 * 1000)} 小时` : fallback;

function latestBackup(project: ProjectSummary) {
  return project.latestBackup ?? null;
}

function ProjectForm({ busy, onSubmit, onCancel }: {
  busy: boolean;
  onSubmit: (values: ProjectValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [image, setImage] = useState<{ imageId: string; imageVersionId: string }>();
  const [type, setType] = useState<ProjectType>(1);
  const [error, setError] = useState('');
  const feishu = type === 2;
  const automaticName = feishu;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return <form className="project-form" aria-label="创建项目" onKeyDown={event => {
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
    try { await onSubmit({ name: automaticName ? '' : trimmedName, requirementUrl: feishu ? url.trim() : null, type, ...image }); }
    catch (err) { setError(err instanceof Error ? err.message : '保存失败，请重试。'); }
  }}>
    <label>项目类型<select value={type} disabled={busy} onChange={event => { const next = Number(event.target.value) as ProjectType; setType(next); if (next === 3 && !name.trim()) setName('本周项目'); }}><option value={1}>普通项目</option><option value={2}>飞书项目</option><option value={3}>本周项目</option></select></label>
    <label>项目名称<input ref={input} required={!automaticName} maxLength={100} value={automaticName ? '' : name} disabled={busy || automaticName} placeholder={automaticName ? '自动使用飞书需求名称' : type === 3 ? '例如：本周重点事项' : '例如：订单系统改造'} onChange={event => setName(event.target.value)} /></label>
    {feishu && <label>飞书需求链接<input type="url" required maxLength={4096} value={url} disabled={busy} placeholder="https://…" onChange={event => setUrl(event.target.value)} /></label>}
    <ImagePicker disabled={busy} onChange={setImage} />
    <p className="project-form-hint">飞书项目自动读取需求名称；本周项目每周只能创建一个。创建项目后立即准备 Sandbox，就绪后可进入项目，项目内会话共享该环境。</p>
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="project-form-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? automaticName ? '正在读取飞书需求并创建…' : '创建中…' : '创建项目'}</button></div>
  </form>;
}

function ProjectCard({ project, config, onUpdate, onRebuildSandbox, onBackup, onResumeSandbox, onCheckpointSandbox, onOpenProject, onViewBackup, onStatus }: Pick<Props, 'config' | 'onUpdate' | 'onRebuildSandbox' | 'onBackup' | 'onResumeSandbox' | 'onCheckpointSandbox' | 'onOpenProject' | 'onViewBackup'> & {
  project: ProjectSummary;
  onStatus: (name: string, status: 'active' | 'completed') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const [chooseRestoreVersion, setChooseRestoreVersion] = useState(false);
  const [restoreVersionId, setRestoreVersionId] = useState('');
  const status = project.status ?? (project.archivedAt ? 'archived' : 'active');
  const archived = status === 'archived';
  const completed = status === 'completed';
  const operation = project.sandboxOperation;
  const operating = operation?.status === 'running';
  const hasTask = Boolean(project.activeSessionId);
  const backup = latestBackup(project);
  const cleanupPending = project.pendingSandboxCleanup?.some(item => item.id !== project.sandbox?.id) ?? false;
  const sandboxNormal = project.executionMode === 'sandbox' && project.sandbox?.status === 'ready'
    && !(operation?.status === 'failed' && ['create', 'resume'].includes(operation.kind));
  const sandboxPaused = project.executionMode === 'sandbox' && project.sandbox?.status === 'paused';
  const sandboxBroken = project.executionMode === 'sandbox' && Boolean(project.sandbox)
    && ['unavailable', 'ready'].includes(project.sandbox!.status) && !sandboxNormal;
  const sandboxMissing = project.executionMode === 'sandbox' && !project.sandbox;
  const latestImage = project.imageSelection ? { reference: project.imageSelection.image, id: project.imageSelection.image, repoDigests: [] } : config?.sandbox?.imageIdentity;
  const canRestore = project.executionMode === 'sandbox' && (archived || sandboxMissing || sandboxBroken) && Boolean(backup) && !hasTask && !operating;
  const typeLabel = projectTypeLabel(project.type, project.weekOf);
  const displayName = projectDisplayName(project);

  async function run(label: string, action: () => Promise<ProjectSummary>) {
    if (busy || operating) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (err) { setError(`${label}失败：${err instanceof Error ? err.message : '请重试。'}`); }
    finally { setBusy(false); }
  }
  async function changeStatus() {
    if (pending.current || busy || operating) return;
    pending.current = true; setBusy(true); setError('');
    try { const next = completed ? 'active' : 'completed'; await onUpdate(project.id, { status: next }); onStatus(project.name, next); }
    catch (err) { setError(`${completed ? '恢复使用中' : '标记完成'}失败：${err instanceof Error ? err.message : '请重试。'}`); }
    finally { pending.current = false; setBusy(false); }
  }
  function restore() {
    if (!backup || !canRestore) return;
    const action = archived ? '恢复项目' : '恢复环境';
    if (!window.confirm(`将使用 ${date(backup.createdAt)} 的最新备份${action}。${archived ? '使用所选版本或仓库默认版本创建新环境，服务进程需要重新启动。' : ''}该时间之后未备份的文件和对话上下文可能无法恢复。`)) return;
    void run(action, () => onRebuildSandbox(project.id, archived && restoreVersionId ? restoreVersionId : undefined));
  }
  const openDisabled = !canEnterProject(project);
  const sandboxDescription = project.executionMode === 'local' ? '本地运行'
    : operating ? operation.phase
    : sandboxNormal ? <span className="project-sandbox-detail"><span>就绪</span><code title={project.sandbox!.id} aria-label={`Sandbox ID ${project.sandbox!.id}`}>{project.sandbox!.id.slice(0, 6)}</code><SandboxVersion image={project.sandbox!.image} latestImage={latestImage} /></span>
    : sandboxPaused ? <span className="project-sandbox-detail"><span>已暂停（Checkpoint）</span><code title={project.sandbox!.id} aria-label={`Sandbox ID ${project.sandbox!.id}`}>{project.sandbox!.id.slice(0, 6)}</code><SandboxVersion image={project.sandbox!.image} latestImage={latestImage} /></span>
    : project.sandbox?.status === 'starting' ? '准备中'
    : project.sandbox?.status === 'unknown' ? '状态查询失败，请稍后刷新'
    : sandboxBroken ? '异常'
    : '无 Sandbox';

  return <article className={`project-card ${archived ? 'archived' : ''}`} aria-label={displayName}>
    <div className="project-card-heading"><span className="project-folder" aria-hidden="true">▱</span><div className="project-card-statuses"><span className="project-type-badge">{typeLabel}</span>{archived && <span className="project-archived-badge">已归档</span>}<span className={`project-status ${project.activeSessionId ? 'active' : ''}`}>{project.activeSessionId ? '任务执行中' : project.executionMode === 'local' ? '本地项目' : operating ? operation.phase : project.sandbox ? states[project.sandbox.status] : '无 Sandbox'}</span></div></div>
    <h2>{openDisabled ? <span className="project-title-disabled">{displayName}</span> : <button className="project-title-button" onClick={() => onOpenProject(project.id)}>{displayName}</button>}</h2>
    {project.requirementUrl && /^https?:\/\//i.test(project.requirementUrl) ? <div className="project-requirement-wrap"><a className="project-requirement" href={project.requirementUrl} target="_blank" rel="noopener noreferrer" title={project.requirementUrl}>飞书需求 ↗<span>{project.requirementUrl}</span></a>{project.requirementStatus && <p className="project-requirement-status"><span>飞书项目状态</span><strong>{project.requirementStatus}</strong></p>}</div> : project.type === 2 ? <p className="project-unlinked">飞书需求待绑定</p> : <p className="project-unlinked">{typeLabel}</p>}
      <dl className="project-details"><div><dt>项目镜像</dt><dd>{project.imageSelection ? `${project.imageSelection.imageName} · ${project.imageSelection.version}` : '系统默认镜像'}</dd></div><div><dt>会话</dt><dd>{project.sessionCount} 个</dd></div><div><dt>Sandbox</dt><dd>{sandboxDescription}</dd></div><div><dt>最新备份</dt><dd>{backup ? onViewBackup && project.archiveVersions?.length ? <ArchiveVersionBadge project={project} onView={onViewBackup} /> : <time dateTime={backup.createdAt} title={date(backup.createdAt)}>{backupDate(backup.createdAt)}</time> : '暂无备份'}</dd></div><div><dt>开始时间</dt><dd><time dateTime={project.createdAt}>{date(project.createdAt)}</time></dd></div></dl>
    <div className="project-action-groups">
      <section className="project-action-group" aria-label="项目操作">
        <h3>项目操作</h3>
        <div className="project-card-actions">
          {archived && backup ? <button className="primary-button" disabled={busy || operating || hasTask} onClick={restore}>恢复项目</button>
            : archived ? <span className="project-action-note">暂无可恢复备份</span>
            : <button className="primary-button" disabled={openDisabled || busy || operating} onClick={() => onOpenProject(project.id)}>进入项目 <span aria-hidden="true">→</span></button>}
          {!archived && <button className="project-archive-button" disabled={busy || operating} title={completed ? '恢复为使用中，才能继续对话' : '完成满 1 天后自动归档'} onClick={() => void changeStatus()}>{busy ? '处理中…' : completed ? '恢复使用中' : '标记已完成'}</button>}
        </div>
      </section>
      {project.executionMode === 'sandbox' && !archived && <section className="project-action-group" aria-label="Sandbox 操作">
        <h3>Sandbox 操作</h3>
        <div className="project-card-actions">
          {sandboxPaused ? <button className="secondary-button" disabled={busy || operating || hasTask} onClick={() => void run('恢复运行', () => onResumeSandbox(project.id))}>恢复运行</button>
            : sandboxNormal ? <><button className="secondary-button" disabled={busy || operating || hasTask} onClick={() => void run('Checkpoint', () => onCheckpointSandbox(project.id))}>Checkpoint · 暂停</button><button className="secondary-button" disabled={busy || operating || hasTask} onClick={() => void run('立即备份', () => onBackup(project.id))}>立即备份</button></>
            : !sandboxBroken && !sandboxMissing ? <span className="project-action-note">等待状态就绪后操作</span>
            : backup ? <button className="secondary-button" disabled={busy || operating || hasTask} onClick={restore}>恢复环境</button>
            : <button className="secondary-button" disabled={busy || operating || hasTask} onClick={() => void run('重建 Sandbox', () => onRebuildSandbox(project.id))}>重建 Sandbox</button>}
        </div>
      </section>}
    </div>
    {operation && !(operation.kind === 'backup' && operation.status === 'succeeded') && <p className={`project-operation ${operation.status === 'failed' ? 'failed' : ''}`} role={operation.status === 'failed' ? 'alert' : 'status'}><strong>{operationLabels[operation.kind]}：{operation.status === 'running' ? operation.phase : operation.status === 'succeeded' ? '已完成' : '失败'}</strong>{operation.error && <span>{operation.error}</span>}</p>}
    {sandboxPaused && !operating && <p className="project-rebuild-hint">Checkpoint 已保存，恢复运行并验证就绪后可进入项目。</p>}
    {archived && project.executionMode === 'sandbox' && <div className="project-rebuild-hint">
      <p>恢复时优先使用{project.imageSelection ? '原仓库默认版本' : '当前系统默认镜像'}；文件和对话历史从备份恢复，服务需要重新启动。</p>
      {project.imageSelection && <><button className="secondary-button" disabled={busy || operating} onClick={() => setChooseRestoreVersion(value => !value)}>选择恢复版本</button>
        {chooseRestoreVersion && <RestoreVersionPicker imageId={project.imageSelection.imageId} disabled={busy || operating} value={restoreVersionId} onChange={setRestoreVersionId} />}</>}
    </div>}
    {cleanupPending && !operating && <p className="project-rebuild-hint" role="status">旧环境待清理，系统将自动重试。</p>}
    {!operation && sandboxMissing && backup && <p className="project-rebuild-hint">当前没有 Sandbox，可使用最新备份恢复环境。</p>}
    {error && <p className="project-error" role="alert">{error}</p>}
  </article>;
}

export default function ProjectsPage({ projects, config, loading, onRefresh, onCreate, onUpdate, onRebuildSandbox, onBackup, onResumeSandbox, onCheckpointSandbox, onOpenProject, onViewBackup, onMenu, onBack, initialView = 'active' }: Props) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'active' | 'completed' | 'archived'>(initialView);
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
  useEffect(() => {
    if (!projects.some(project => project.sandboxOperation?.status === 'running' || project.sandbox?.status === 'starting')) return;
    const timer = window.setInterval(() => { void onRefresh().catch(err => setError(err instanceof Error ? err.message : '状态读取失败，请刷新重试。')); }, 3_000);
    return () => window.clearInterval(timer);
  }, [projects, onRefresh]);
  const card = (project: ProjectSummary) => <ProjectCard key={project.id} project={project} config={config} onUpdate={onUpdate} onRebuildSandbox={onRebuildSandbox} onBackup={onBackup} onResumeSandbox={onResumeSandbox} onCheckpointSandbox={onCheckpointSandbox} onOpenProject={onOpenProject} onViewBackup={onViewBackup} onStatus={(name, status) => {
    setMessage(status === 'completed' ? `「${name}」已标记完成；满 1 天后会自动归档并删除 Sandbox。` : `「${name}」已恢复为使用中。`);
    activeTab.current?.focus();
  }} />;

  const empty = <div className="projects-empty"><span aria-hidden="true">▱</span><h2>{query.trim() && inView.length ? '没有匹配的项目' : view === 'archived' ? '还没有归档项目' : view === 'completed' ? '还没有已完成项目' : projects.length ? '暂无使用中的项目' : '从一个项目开始'}</h2><p>{query.trim() && inView.length ? '试试其他项目名称、需求链接或 Sandbox ID。' : view === 'archived' ? '归档项目会按周显示；恢复时使用最新成功备份创建环境。' : view === 'completed' ? '已完成项目不能继续对话；恢复为使用中后才可继续。' : '先创建项目，再开启会话。飞书需求可以稍后关联。'}</p>{view === 'active' && !inView.length && canCreate && !creating && <button className="primary-button" onClick={() => setCreating(true)}>{projects.length ? '创建项目' : '创建第一个项目'}</button>}</div>;

  return <main className="main-pane projects-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>项目</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="projects-scroll"><div className="projects-heading"><div><span className="projects-eyebrow">PROJECT WORKSPACE</span><h1>项目</h1><p>项目标记为已完成满 {duration(config?.sandbox?.archivedReclaimAfterMs, '1 天')} 后自动归档并释放 Sandbox；恢复时使用最新成功备份创建环境。</p></div><button ref={createButton} className="primary-button" disabled={!canCreate || creating} onClick={() => setCreating(true)}>＋ 创建项目</button></div>
      {!config ? <p className="project-notice" role="status">正在读取项目配置…</p> : !canCreate && <p className="project-notice">创建项目需要先在服务端配置 Cellbox。已有项目仍可查看。</p>}
      {error && <p className="project-error project-page-error" role="alert">{error}</p>}
      {message && <p className="project-message" role="status">{message}</p>}
      {creating && canCreate && <section className="project-create-panel"><h2>创建项目</h2><ProjectForm busy={busy} onCancel={stopCreating} onSubmit={async values => {
        setBusy(true);
        try { const project = await onCreate(values); stopCreating(); setView('active'); setMessage(`「${project.name}」已创建，Sandbox 就绪后可进入项目。`); }
        finally { setBusy(false); }
      }} /></section>}
      <div className="projects-toolbar"><div className="project-tabs" role="group" aria-label="项目状态"><button ref={activeTab} className={view === 'active' ? 'selected' : ''} aria-pressed={view === 'active'} onClick={() => setView('active')}>使用中 <span>{activeCount}</span></button><button className={view === 'completed' ? 'selected' : ''} aria-pressed={view === 'completed'} onClick={() => setView('completed')}>已完成 <span>{completedCount}</span></button><button ref={archivedTab} className={view === 'archived' ? 'selected' : ''} aria-pressed={view === 'archived'} onClick={() => setView('archived')}>归档 <span>{archivedCount}</span></button></div><div><input aria-label="搜索项目" placeholder="搜索项目、需求链接或 Sandbox" value={query} onChange={event => setQuery(event.target.value)} /><button className="secondary-button" disabled={loading} onClick={async () => { setError(''); try { await onRefresh(); } catch (err) { setError(err instanceof Error ? err.message : '刷新失败，请重试。'); } }}>{loading ? '刷新中…' : '刷新'}</button></div></div>
      <p className="projects-archive-hint">{view === 'archived' ? '按归档日期每周一组。恢复会创建新的 Sandbox。' : view === 'completed' ? '已完成项目必须恢复为使用中，才能继续对话。' : '可将项目标记为已完成；满 1 天后系统会归档并删除其 Sandbox。'}</p>
      {!projects.length && loading ? <section className="project-grid" aria-busy="true"><div className="projects-empty" role="status"><span className="spinner" /> 正在读取项目…</div></section>
        : !visible.length ? <section className="project-grid">{empty}</section>
        : view === 'archived' ? <div className="project-week-groups" aria-label="已归档项目列表">{archivedGroups.map(group => <section className="project-week-group" key={group.key}><h2>{group.label}<span>{group.projects.length}</span></h2><div className="project-grid">{group.projects.map(card)}</div></section>)}</div>
        : <section className="project-grid" aria-label={`${view === 'completed' ? '已完成' : '使用中'}项目列表`}>{visible.map(card)}</section>}
    </div>
  </main>;
}
