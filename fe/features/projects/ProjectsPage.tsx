import ImagePicker from '../images/ImagePicker';
import RestoreVersionPicker from '../images/RestoreVersionPicker';
import { useEffect, useRef, useState } from 'react';
import type { AppConfig, ProjectSummary, ProjectType } from '../../../protocol/types';
import { projectDisplayName, projectTypeLabel } from '../../../util/project-types';
import { canEnterProject } from '../../../util/project-sandbox';
import { projectSandboxActions, type ProjectSandboxAction } from '../../../util/project-sandbox-actions';
import type { ProjectValues, ProjectUpdate, ProjectResumeTimeline as ResumeTimelineState } from './useProjects';
import ResumeTimeline from './ResumeTimeline';
import { groupArchivedProjectsByWeek } from './project-groups';
import ArchiveVersionBadge from './ArchiveVersionBadge';
import './ProjectsPage.css';
import ProjectToolGrants from './ProjectToolGrants';

type Props = {
  projects: ProjectSummary[];
  resumeTimelines?: Record<string, ResumeTimelineState>;
  config: AppConfig | null;
  loading: boolean;
  onRefresh: () => Promise<unknown>;
  onCreate: (values: ProjectValues) => Promise<ProjectSummary>;
  onUpdate: (id: string, values: ProjectUpdate) => Promise<ProjectSummary>;
  onDelete: (id: string) => Promise<void>;
  onCreateSandbox: (id: string) => Promise<ProjectSummary>;
  onRestoreSandbox: (id: string, imageVersionId?: string) => Promise<ProjectSummary>;
  onReleaseSandbox: (id: string) => Promise<ProjectSummary>;
  onResumeSandbox: (id: string) => Promise<ProjectSummary>;
  onBackupSandbox: (id: string) => Promise<ProjectSummary>;
  onCheckpointSandbox: (id: string) => Promise<ProjectSummary>;
  onArchiveProject: (id: string, options?: { useExistingBackup?: boolean }) => Promise<ProjectSummary>;
  onOpenProject: (id: string) => void;
  onViewBackup?: (archiveKey: string, versionId: string | undefined,
    meta: { sizeBytes?: number; bytesAdded?: number; createdAt: string }) => void;
  onMenu: () => void;
  onBack: () => void;
  /** Used by the archive route and component tests; the product default is active. */
  initialView?: 'active' | 'completed' | 'archived';
};

const operationLabels = { rebuild: '重建环境', create: '创建 Sandbox', checkpoint: 'Checkpoint', backup: '备份', restore: '恢复环境', resume: '恢复运行', release: '释放运行环境', refresh: '刷新运行环境', archive: '归档', delete: '删除项目' };
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

function compareProjectsByCreation(a: ProjectSummary, b: ProjectSummary) {
  const aCreatedAt = Date.parse(a.createdAt);
  const bCreatedAt = Date.parse(b.createdAt);
  const aTimestamp = Number.isFinite(aCreatedAt) ? aCreatedAt : Number.NEGATIVE_INFINITY;
  const bTimestamp = Number.isFinite(bCreatedAt) ? bCreatedAt : Number.NEGATIVE_INFINITY;
  if (aTimestamp !== bTimestamp) return aTimestamp > bTimestamp ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function projectImageLabel(project: ProjectSummary) {
  if (project.executionMode === 'local') return '本地运行';
  const actual = project.sandbox?.image;
  if (actual) return [actual.version ?? actual.reference, actual.revisionId ? `revision ${actual.revisionId}` : undefined].filter(Boolean).join(' · ');
  if (project.imageSelection?.migrationRequired) return `${project.imageSelection.imageName} · 需要迁移`;
  if (project.imageSelection?.selectionPolicy === 'latest') return `${project.imageSelection.imageName} · latest`;
  if (project.sandbox) return project.imageSelection ? `${project.imageSelection.imageName} · template` : '系统默认 template';
  return project.imageSelection ? `${project.imageSelection.imageName} · Cellbox stable` : '系统默认 template · Cellbox stable';
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
    <p className="project-form-hint">飞书项目自动读取需求名称；本周项目按周归类，已存在时会提示。创建后立即进入项目，可以先输入任务，环境会在后台准备。</p>
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="project-form-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? automaticName ? '正在读取飞书需求并创建…' : '创建中…' : '创建项目'}</button></div>
  </form>;
}

function DeletingProjectRow({ project, onRetry }: { project: ProjectSummary; onRetry: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const operation = project.sandboxOperation?.kind === 'delete' ? project.sandboxOperation : undefined;
  const detail = operation?.status === 'running' ? operation.phase
    : operation?.status === 'failed' ? operation.error || '删除失败，可以重试。'
      : operation?.status === 'unknown' ? operation.error || '删除结果待确认，可以重试。'
        : '正在删除项目…';
  return <div className="project-deleting-row" aria-label={`${projectDisplayName(project)}，删除中`}>
    <div><strong>{projectDisplayName(project)}</strong><span role={operation?.status === 'failed' ? 'alert' : 'status'}>{detail}</span></div>
    <button className="secondary-button" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await onRetry(project.id); } catch { /* The refreshed project row displays the delete failure. */ }
      finally { setBusy(false); }
    }}>{busy ? '重试中…' : '重试删除'}</button>
  </div>;
}

function ProjectCard({ project, resumeTimeline, config, onRefresh, onUpdate, onDelete, onCreateSandbox, onRestoreSandbox, onReleaseSandbox, onResumeSandbox, onCheckpointSandbox, onBackupSandbox, onArchiveProject, onOpenProject, onViewBackup, onStatus }: Pick<Props, 'config' | 'onRefresh' | 'onUpdate' | 'onDelete' | 'onCreateSandbox' | 'onRestoreSandbox' | 'onReleaseSandbox' | 'onResumeSandbox' | 'onCheckpointSandbox' | 'onBackupSandbox' | 'onArchiveProject' | 'onOpenProject' | 'onViewBackup'> & {
  project: ProjectSummary;
  resumeTimeline?: ResumeTimelineState;
  onStatus: (name: string, status: 'active' | 'completed') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showToolGrants, setShowToolGrants] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const [idCopyStatus, setIdCopyStatus] = useState('');
  const [chooseRestoreVersion, setChooseRestoreVersion] = useState(false);
  const [restoreVersionId, setRestoreVersionId] = useState('');
  const status = project.status ?? (project.archivedAt ? 'archived' : 'active');
  const archived = status === 'archived';
  const completed = status === 'completed';
  const operation = project.sandboxOperation;
  const sandboxBackup = project.sandboxBackup;
  const backupCatalogError = sandboxBackup?.catalogError
    ?? (operation?.kind === 'backup' ? operation.catalogError : undefined);
  const backupCatalogOnlyFailure = operation?.kind === 'backup' && sandboxBackup?.status === 'succeeded' && Boolean(backupCatalogError);
  const sandboxView = projectSandboxActions(project);
  const sandboxPaused = sandboxView.state === 'paused';
  const legacyCheckpointBackupFailure = sandboxPaused && operation?.kind === 'checkpoint' && operation.status === 'failed';
  const backupFailed = sandboxBackup?.status === 'failed' || legacyCheckpointBackupFailure;
  const hasTask = Boolean(project.activeSessionId);
  const backup = latestBackup(project);
  const cleanupPending = project.pendingSandboxCleanup?.some(item => item.id !== project.sandbox?.id) ?? false;
  const canRestore = project.executionMode === 'sandbox' && Boolean(backup)
    && sandboxView.actions.some(action => action.id === 'restore') && !hasTask;
  const archiveRetry = (operation?.kind === 'archive' && operation.status === 'failed')
    || Boolean(project.archiveCleanupSourceId) || (archived && (Boolean(project.pendingSandboxCleanup?.length) || Boolean(operation?.cleanupError)));
  const archiveRetryCleanup = archived || Boolean(project.archiveCleanupSourceId);
  const hasRetainedMounts = Boolean(project.sandboxMounts?.length);
  const releasedWithMounts = !project.sandbox && hasRetainedMounts;
  const archiveHasDiskSource = Boolean(project.sandbox || hasRetainedMounts);
  const archiveBaseDisabled = busy || hasTask || sandboxBackup?.status === 'running'
    || (sandboxView.state === 'processing' && !project.archiveCleanupSourceId);
  const archiveDisabled = archiveBaseDisabled || (!archiveRetryCleanup && (!archiveHasDiskSource
    || (!releasedWithMounts && !sandboxPaused && project.sandbox?.phase !== 'failed')));
  const canUseExistingBackup = !archived && !project.archiveCleanupSourceId && Boolean(backup);
  const typeLabel = projectTypeLabel(project.type, project.weekOf);
  const displayName = projectDisplayName(project);

  async function copyProjectId() {
    try { await navigator.clipboard.writeText(project.id); setIdCopyStatus('已复制完整 ID'); }
    catch { setIdCopyStatus(`复制失败，完整 ID：${project.id}`); }
  }

  async function run(label: string, action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (err) { setError(`${label}失败：${err instanceof Error ? err.message : '请重试。'}`); }
    finally { setBusy(false); }
  }
  async function changeStatus() {
    if (pending.current || busy) return;
    pending.current = true; setBusy(true); setError('');
    try { const next = completed ? 'active' : 'completed'; await onUpdate(project.id, { status: next }); onStatus(project.name, next); }
    catch (err) { setError(`${completed ? '恢复使用中' : '标记完成'}失败：${err instanceof Error ? err.message : '请重试。'}`); }
    finally { pending.current = false; setBusy(false); }
  }
  async function deleteCompletedProject() {
    if (!completed || pending.current || busy) return;
    const message = '删除后项目会从列表移除。系统会先将工作区磁盘数据备份到 S3，备份成功后才清理 Sandbox、挂载盘、会话和项目。运行中的 Sandbox 会先暂停。删除不会使用旧备份兜底；如果当前环境无法生成最新备份（例如已释放环境），删除会失败并保留项目。确认删除？';
    if (!window.confirm(message)) return;
    pending.current = true;
    try { await run('删除项目', () => onDelete(project.id)); }
    finally { pending.current = false; }
  }
  function restore() {
    if (!canRestore) return;
    const action = archived ? '恢复项目' : '从备份恢复';
    const message = `将使用 ${date(backup!.createdAt)} 的最新备份恢复项目。该时间之后未备份的文件和对话上下文可能无法恢复。恢复会创建新的 Sandbox 和新的挂载盘，原挂载盘保留；服务进程需要重新启动。`;
    if (!window.confirm(message)) return;
    void run(action, () => onRestoreSandbox(project.id, restoreVersionId || undefined));
  }
  function release() {
    if (!project.sandbox || busy || hasTask || pending.current) return;
    if (!window.confirm('释放运行环境会结束其中的进程并停止 Sandbox。本次操作会保留项目、会话和挂载盘，不主动清除 Cellbox 元数据；之后可新建 Sandbox 并复用挂载盘。确认释放运行环境？')) return;
    void run('释放运行环境', () => onReleaseSandbox(project.id));
  }
  function archive(useExistingBackup = false) {
    if ((useExistingBackup ? archiveBaseDisabled : archiveDisabled) || pending.current) return;
    const message = archiveRetryCleanup
      ? '项目已归档。将继续清理 Sandbox 和缓存，不会重新备份磁盘。确认重试清理？'
      : useExistingBackup
        ? `将使用 ${date(backup!.createdAt)} 的已有备份归档；该时间之后未备份的数据不会保存。归档会删除 Sandbox，其运行进程将结束。确认归档？`
        : '将备份已暂停的工作区并归档项目，再尝试清理环境。当前不支持跳过 Checkpoint 直接归档运行中的磁盘。确认归档？';
    if (!window.confirm(message)) return;
    pending.current = true;
    void run(archiveRetryCleanup ? '清理归档环境' : '归档', () => onArchiveProject(project.id, useExistingBackup ? { useExistingBackup: true } : {}))
      .finally(() => { pending.current = false; });
  }
  async function refreshStatus() {
    if (refreshing) return;
    setRefreshing(true); setError('');
    try { await onRefresh(); }
    catch (err) { setError(`刷新状态失败：${err instanceof Error ? err.message : '请重试。'}`); }
    finally { setRefreshing(false); }
  }
  function sandboxAction(id: ProjectSandboxAction) {
    if (id === 'refresh') { void refreshStatus(); return; }
    if (id === 'release') { release(); return; }
    if (id === 'restore') { restore(); return; }
    if (id === 'resume') {
      if (busy) return;
      setBusy(true); setError('');
      void onResumeSandbox(project.id).catch(() => {}).finally(() => setBusy(false));
      return;
    }
    const handlers = { checkpoint: onCheckpointSandbox, resume: onResumeSandbox, create: onCreateSandbox, backup: onBackupSandbox };
    const label = sandboxView.actions.find(action => action.id === id)!.label;
    void run(label, () => handlers[id](project.id));
  }
  const openDisabled = !canEnterProject(project);
  const sandboxDescription = <span className="project-sandbox-detail"><span>{sandboxView.label}</span>{project.sandbox && <code title={project.sandbox.id} aria-label={`Sandbox ID ${project.sandbox.id}`}>{project.sandbox.id.slice(0, 6)}</code>}</span>;

  return <article className={`project-card ${archived ? 'archived' : ''}`} aria-label={displayName}>
    <div className="project-card-heading"><span className="project-folder" aria-hidden="true">▱</span><div className="project-card-statuses"><span className="project-type-badge">{typeLabel}</span>{archived && <span className="project-archived-badge">已归档</span>}<span className={`project-status ${project.activeSessionId ? 'active' : ''}`}>{project.activeSessionId ? '任务执行中' : sandboxView.label}</span></div></div>
    <h2>{completed || openDisabled ? <span className="project-title-disabled">{displayName}</span> : <button className="project-title-button" onClick={() => onOpenProject(project.id)}>{displayName}</button>}</h2>
    <div className="project-card-id"><span>项目 ID</span><button type="button" title={project.id} aria-label={`复制项目完整 ID ${project.id}`} onClick={() => void copyProjectId()}><code>{project.id.slice(0, 8)}</code></button>{idCopyStatus && <span role="status">{idCopyStatus}</span>}</div>
    {project.requirementUrl && /^https?:\/\//i.test(project.requirementUrl) ? <div className="project-requirement-wrap"><a className="project-requirement" href={project.requirementUrl} target="_blank" rel="noopener noreferrer" title={project.requirementUrl}>飞书需求 ↗<span>{project.requirementUrl}</span></a>{project.requirementStatus && <p className="project-requirement-status"><span>飞书项目状态</span><strong>{project.requirementStatus}</strong></p>}</div> : project.type === 2 ? <p className="project-unlinked">飞书需求待绑定</p> : <p className="project-unlinked">{typeLabel}</p>}
    <dl className="project-details"><div><dt>项目镜像</dt><dd>{projectImageLabel(project)}</dd></div><div><dt>会话</dt><dd>{project.sessionCount} 个</dd></div><div><dt>Sandbox</dt><dd>{sandboxDescription}</dd></div><div><dt>最新备份</dt><dd>{!completed && onViewBackup && project.archiveVersions?.length ? <ArchiveVersionBadge project={project} onView={onViewBackup} /> : backup ? <time dateTime={backup.createdAt} title={date(backup.createdAt)}>{backupDate(backup.createdAt)}</time> : project.archiveVersions?.[0] ? <time dateTime={project.archiveVersions[0].createdAt} title={date(project.archiveVersions[0].createdAt)}>{backupDate(project.archiveVersions[0].createdAt)}</time> : '暂无备份'}</dd></div>{project.backupPolicy?.enabled && <div><dt>磁盘保留</dt><dd>每个磁盘保留最近 {project.backupPolicy.keepLast} 版</dd></div>}<div><dt>开始时间</dt><dd><time dateTime={project.createdAt}>{date(project.createdAt)}</time></dd></div></dl>
    {(() => { const mounts = project.sandbox?.mounts ?? project.sandboxMounts ?? []; return mounts.length > 0 && <div className="project-mounts"><strong>保留的挂载盘</strong><ul>{mounts.map(mount => <li key={`${mount.volumeId}:${mount.mountPath}`}><code>{mount.mountPath}</code><span>{mount.volumeId}</span>{mount.readOnly && <span>只读</span>}</li>)}</ul></div>; })()}
    {completed ? <section className="project-action-group" aria-label="项目操作"><h3>项目操作</h3><div className="project-card-actions">
      <button className="primary-button" disabled={busy} onClick={() => void changeStatus()}>{busy ? '处理中…' : '恢复'}</button>
      <button className="secondary-button" disabled={busy} onClick={() => void deleteCompletedProject()}>{busy ? '处理中…' : '删除'}</button>
    </div></section> : <div className="project-action-groups">
      <section className="project-action-group" aria-label="项目操作">
        <h3>项目操作</h3>
        <div className="project-card-actions">
          <button className="secondary-button" onClick={() => setShowToolGrants(true)}>工具权限</button>
          {project.executionMode === 'sandbox' && (!archived || archiveRetry) && <>
            <button className="secondary-button" disabled={archiveDisabled} title={!sandboxPaused && !releasedWithMounts && !archiveRetryCleanup ? '请先暂停后归档，或明确选择使用已有备份' : undefined} onClick={() => archive()}>{archiveRetryCleanup ? '重试清理' : archiveRetry ? '重试归档' : '手动归档'}</button>
            {canUseExistingBackup && <button className="secondary-button" disabled={archiveBaseDisabled} onClick={() => archive(true)}>使用已有备份归档</button>}
          </>}
          {archived && backup ? <button className="primary-button" disabled={busy || !canRestore} onClick={restore}>恢复项目</button>
            : archived ? <span className="project-action-note">暂无可恢复备份</span>
            : <button className="primary-button" disabled={openDisabled} onClick={() => onOpenProject(project.id)}>进入项目 <span aria-hidden="true">→</span></button>}
          {!archived && <button className="project-archive-button" disabled={busy} title={completed ? '恢复为使用中，才能继续对话' : '完成满 1 天后尝试归档'} onClick={() => void changeStatus()}>{busy ? '处理中…' : completed ? '恢复使用中' : '标记已完成'}</button>}
        </div>
      </section>
      {project.executionMode === 'sandbox' && !archived && <section className="project-action-group" aria-label="Sandbox 操作">
        <h3>Sandbox 操作</h3>
        <div className="project-card-actions">
          {sandboxView.actions.map(action => <button key={action.id} className="secondary-button"
            disabled={action.id === 'refresh' ? refreshing : busy || hasTask || Boolean(action.disabledReason)}
            title={action.disabledReason ?? (action.id === 'create' && project.sandboxMounts?.length ? '使用 template 当前 stable 创建新 Sandbox，复用保留的挂载盘' : undefined)}
            onClick={() => sandboxAction(action.id)}>{action.id === 'refresh' && refreshing ? '刷新中…' : action.id === 'backup' && backupFailed && sandboxView.state !== 'released' ? '重试磁盘备份' : action.label}</button>)}
        </div>
        {sandboxView.actions.filter(action => action.disabledReason).map(action => <p key={action.id} className="project-rebuild-hint">{action.disabledReason}</p>)}
        {sandboxView.state === 'unknown' && <p className="project-rebuild-hint">状态查询失败或尚未确认，请刷新状态后决定下一步；释放结果以 Cellbox 返回为准。</p>}
        {sandboxView.state === 'released' && <p className="project-rebuild-hint">新建 Sandbox 使用 template 当前 stable{hasRetainedMounts ? '，并复用保留的挂载盘；可直接备份保留的挂载盘' : '；当前未记录保留的挂载盘'}；从备份恢复会创建新的挂载盘。</p>}
      </section>}
    </div>}
    <ResumeTimeline timeline={resumeTimeline} />
    {operation && !(operation.kind === 'resume' && resumeTimeline) && !(operation.kind === 'backup' && operation.status === 'succeeded') && !backupCatalogOnlyFailure && !legacyCheckpointBackupFailure && <p className={`project-operation ${operation.status === 'failed' ? 'failed' : ''}`} role={operation.status === 'failed' ? 'alert' : 'status'}><strong>{operationLabels[operation.kind]}：{operation.status === 'running' ? operation.phase : operation.status === 'succeeded' ? '已完成' : operation.status === 'unknown' ? '结果未知' : '失败'}</strong>{operation.errorCode && <code>{operation.errorCode}</code>}{operation.error && <span>{operation.error}</span>}<time dateTime={operation.updatedAt}>更新于 {date(operation.updatedAt)}</time></p>}
    {sandboxBackup?.status === 'running' && <p className="project-operation" role="status"><strong>磁盘备份：{sandboxBackup.phase || '进行中'}</strong></p>}
    {sandboxBackup?.status === 'unknown' && <p className="project-operation" role="status"><strong>磁盘备份结果未知</strong>{sandboxBackup.error}</p>}
    {backupFailed && <p className="project-operation failed" role="alert"><strong>磁盘备份失败</strong>{sandboxBackup?.error || operation?.error}</p>}
    {backupCatalogError && <p className="project-operation" role="status"><strong>磁盘备份已完成，但目录刷新失败</strong><span>{backupCatalogError}</span><span>可稍后刷新项目状态；无需重试备份。</span></p>}
    {sandboxBackup?.retentionError && <p className="project-operation failed" role="alert"><strong>备份已完成，但旧快照清理失败</strong><span>{sandboxBackup.retentionError}</span></p>}
    {project.backupPolicyError && <p className="project-operation failed" role="alert"><strong>无法读取磁盘备份保留策略</strong><span>{project.backupPolicyError}</span></p>}
    {sandboxPaused && !completed && <p className="project-rebuild-hint">Checkpoint 只暂停环境；磁盘备份需单独操作。恢复运行会继续当前环境。</p>}
    {archived && project.executionMode === 'sandbox' && <div className="project-rebuild-hint">
      <p>恢复时选择{project.imageSelection ? '原仓库默认版本' : '当前系统默认镜像'}；文件和对话历史从备份恢复，服务需要重新启动。</p>
      {project.imageSelection && <><button className="secondary-button" disabled={busy} onClick={() => setChooseRestoreVersion(value => !value)}>选择恢复版本</button>
        {chooseRestoreVersion && <RestoreVersionPicker imageId={project.imageSelection.imageId} disabled={busy} value={restoreVersionId} onChange={setRestoreVersionId} />}</>}
    </div>}
    {archived && operation?.kind === 'archive' && operation.cleanupError
      ? <p className="project-operation" role="status"><strong>已归档，环境清理待重试</strong><span>{operation.cleanupError}</span></p>
      : cleanupPending && <p className="project-rebuild-hint" role="status">旧环境待清理，请检查资源状态后决定是否再次清理。</p>}
    {error && <p className="project-error" role="alert">{error}</p>}
    {!archiveHasDiskSource && !backup && !archived && project.executionMode === 'sandbox' && <p className="project-rebuild-hint">当前没有 Sandbox，也没有成功备份，暂时无法归档。</p>}
    {showToolGrants && <ProjectToolGrants projectId={project.id} name={displayName} onClose={() => setShowToolGrants(false)} />}
  </article>;
}

export default function ProjectsPage({ projects, resumeTimelines = {}, config, loading, onRefresh, onCreate, onUpdate, onDelete, onCreateSandbox, onRestoreSandbox, onReleaseSandbox, onResumeSandbox, onCheckpointSandbox, onBackupSandbox, onArchiveProject, onOpenProject, onViewBackup, onMenu, onBack, initialView = 'active' }: Props) {
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
  const isDeleting = (project: ProjectSummary) => project.status === 'deleting';
  const deletingProjects = projects.filter(isDeleting);
  const visibleDeletingProjects = deletingProjects.filter(project => `${project.id} ${project.name} ${project.requirementUrl ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const activeCount = projects.filter(project => projectStatus(project) === 'active').length;
  const completedCount = projects.filter(project => projectStatus(project) === 'completed').length;
  const archivedCount = projects.filter(project => projectStatus(project) === 'archived').length;
  const inView = projects.filter(project => projectStatus(project) === view);
  const visible = inView.filter(project => `${project.id} ${project.name} ${project.requirementUrl ?? ''} ${project.sandbox?.id ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (view === 'active') visible.sort(compareProjectsByCreation);
  const archivedGroups = view === 'archived' ? groupArchivedProjectsByWeek(visible) : [];
  const canCreate = config?.sandbox?.enabled === true;
  const stopCreating = () => { setCreating(false); setTimeout(() => createButton.current?.focus(), 0); };
  useEffect(() => {
    if (!projects.some(project => isDeleting(project) || project.sandboxOperation?.status === 'running' || project.sandboxBackup?.status === 'running' || project.sandbox?.status === 'starting')) return;
    const timer = window.setInterval(() => { void onRefresh().catch(err => setError(err instanceof Error ? err.message : '状态读取失败，请刷新重试。')); }, 3_000);
    return () => window.clearInterval(timer);
  }, [projects, onRefresh]);
  const card = (project: ProjectSummary) => <ProjectCard key={project.id} project={project} resumeTimeline={resumeTimelines[project.id]} config={config} onRefresh={onRefresh} onUpdate={onUpdate} onDelete={onDelete} onCreateSandbox={onCreateSandbox} onRestoreSandbox={onRestoreSandbox} onReleaseSandbox={onReleaseSandbox} onResumeSandbox={onResumeSandbox} onCheckpointSandbox={onCheckpointSandbox} onBackupSandbox={onBackupSandbox} onArchiveProject={async (id, options) => {
    const result = await onArchiveProject(id, options);
    setMessage(`「${project.name}」已归档，可在“归档”页查看。`);
    return result;
  }} onOpenProject={onOpenProject} onViewBackup={onViewBackup} onStatus={(name, status) => {
    setMessage(status === 'completed' ? `「${name}」已标记为已完成。` : `「${name}」已恢复为使用中。`);
    activeTab.current?.focus();
  }} />;

  const empty = <div className="projects-empty"><span aria-hidden="true">▱</span><h2>{query.trim() && inView.length ? '没有匹配的项目' : view === 'archived' ? '还没有归档项目' : view === 'completed' ? '还没有已完成项目' : projects.length ? '暂无使用中的项目' : '从一个项目开始'}</h2><p>{query.trim() && inView.length ? '试试其他项目名称、项目 ID、需求链接或 Sandbox ID。' : view === 'archived' ? '归档项目会按周显示；恢复时使用最新成功备份创建环境。' : view === 'completed' ? '已完成项目不能继续对话；恢复为使用中后才可继续。' : '先创建项目，再开启会话。飞书需求可以稍后关联。'}</p>{view === 'active' && !inView.length && canCreate && !creating && <button className="primary-button" onClick={() => setCreating(true)}>{projects.length ? '创建项目' : '创建第一个项目'}</button>}</div>;

  return <main className="main-pane projects-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>项目</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="projects-scroll"><div className="projects-heading"><div><span className="projects-eyebrow">PROJECT WORKSPACE</span><h1>项目</h1><p>项目标记为已完成满 {duration(config?.sandbox?.archivedReclaimAfterMs, '1 天')} 后系统会尝试归档；恢复时使用最新成功备份创建环境。</p></div><button ref={createButton} className="primary-button" disabled={!canCreate || creating} onClick={() => setCreating(true)}>＋ 创建项目</button></div>
      {!config ? <p className="project-notice" role="status">正在读取项目配置…</p> : !canCreate && <p className="project-notice">创建项目需要先在服务端配置 Cellbox。已有项目仍可查看。</p>}
      {error && <p className="project-error project-page-error" role="alert">{error}</p>}
      {message && <p className="project-message" role="status">{message}</p>}
      {creating && canCreate && <section className="project-create-panel"><h2>创建项目</h2><ProjectForm busy={busy} onCancel={stopCreating} onSubmit={async values => {
        setBusy(true);
        try { const project = await onCreate(values); setCreating(false); onOpenProject(project.id); }
        finally { setBusy(false); }
      }} /></section>}
      <div className="projects-toolbar"><div className="project-tabs" role="group" aria-label="项目状态"><button ref={activeTab} className={view === 'active' ? 'selected' : ''} aria-pressed={view === 'active'} onClick={() => setView('active')}>使用中 <span>{activeCount}</span></button><button className={view === 'completed' ? 'selected' : ''} aria-pressed={view === 'completed'} onClick={() => setView('completed')}>已完成 <span>{completedCount}</span></button><button ref={archivedTab} className={view === 'archived' ? 'selected' : ''} aria-pressed={view === 'archived'} onClick={() => setView('archived')}>归档 <span>{archivedCount}</span></button></div><div><input aria-label="搜索项目" placeholder="搜索名称、项目 ID 或 Sandbox" value={query} onChange={event => setQuery(event.target.value)} /><button className="secondary-button" disabled={loading} onClick={async () => { setError(''); try { await onRefresh(); } catch (err) { setError(err instanceof Error ? err.message : '刷新失败，请重试。'); } }}>{loading ? '刷新中…' : '刷新'}</button></div></div>
      {deletingProjects.length > 0 && <section className="project-deleting-section" aria-label="删除中项目"><h2>删除中 <span>{deletingProjects.length}</span></h2>{visibleDeletingProjects.length ? visibleDeletingProjects.map(project => <DeletingProjectRow key={project.id} project={project} onRetry={onDelete} />) : <p className="project-deleting-empty">没有匹配的删除中项目。</p>}</section>}
      <p className="projects-archive-hint">{view === 'archived' ? '按归档日期每周一组。恢复会创建新的 Sandbox。' : view === 'completed' ? '已完成项目必须恢复为使用中，才能继续对话。' : '可将项目标记为已完成；满 1 天后系统会尝试归档，运行中的环境须先暂停。'}</p>
      {!projects.length && loading ? <section className="project-grid" aria-busy="true"><div className="projects-empty" role="status"><span className="spinner" /> 正在读取项目…</div></section>
        : !visible.length ? <section className="project-grid">{empty}</section>
        : view === 'archived' ? <div className="project-week-groups" aria-label="已归档项目列表">{archivedGroups.map(group => <section className="project-week-group" key={group.key}><h2>{group.label}<span>{group.projects.length}</span></h2><div className="project-grid">{group.projects.map(card)}</div></section>)}</div>
        : <section className="project-grid" aria-label={`${view === 'completed' ? '已完成' : '使用中'}项目列表`}>{visible.map(card)}</section>}
    </div>
  </main>;
}
