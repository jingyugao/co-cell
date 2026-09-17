import TurnContextStatus from './features/chat/TurnContextStatus';
import BillingRail from './features/chat/BillingRail';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig, Session, SessionSummary, Settings } from '../protocol/types';
import { useProjects } from './features/projects/useProjects';
import { useSessionStream } from './features/chat/useSessionStream';
import { usePromptDraft } from './features/chat/usePromptDraft';
import { requirementPrompt } from './features/projects/requirement-prompt';
import ModelPicker from './features/chat/ModelPicker';
import { DEFAULT_MODEL } from '../util/models';
import { projectDisplayName } from '../util/project-types';
import { Icon, Mark } from './components/Icon';
import { api, errorMessage as message } from './lib/api';
import { readRoute, resolveSelection, routeUrl, type Page, type Selection } from './lib/navigation';
import TurnProgress from './features/chat/TurnProgress';
import { mergeApprovalDecision } from './features/chat/UserApprovalCard';
import TurnItems from './features/chat/TurnItems';
import SettingsModal from './features/chat/SettingsModal';
import { effectiveSettings } from './features/chat/settings';
import SandboxManager from './features/sandboxes/SandboxManager';
import ProjectsPage from './features/projects/ProjectsPage';
import ProjectPicker from './features/projects/ProjectPicker';
import SharedFilesPage from './features/shared-files/SharedFilesPage';
import ConnectionsPage from './features/connections/ConnectionsPage';
import ImprovementsPage from './features/improvements/ImprovementsPage';
import ArchiveBrowser from './features/archives/ArchiveBrowser';
import { WorkspaceFileView, type ProjectFileSelection } from './features/workspace-files/WorkspaceFileView';

const basename = (path: string) => path.replace(/[\\/]$/, '').split(/[\\/]/).pop() || '工作目录';
const statusLabels: Record<Session['status'], string> = { idle: '就绪', running: '执行中', completed: '已完成', failed: '执行失败', cancelled: '已停止' };
type ArchivableSession = { archivedAt: string | null };
const isArchived = (value: ArchivableSession) => Boolean(value.archivedAt);
const archivedAt = (value: ArchivableSession) => value.archivedAt || '';
const dateTime = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';

export default function App() {
  const [page, setPage] = useState<Page>(() => readRoute().page);
  const currentPage = useRef(page); currentPage.current = page;
  const currentUrl = useRef(window.location.pathname + window.location.search + window.location.hash);
  const filesDirty = useRef(false);
  const updateFilesDirty = useCallback((dirty: boolean) => { filesDirty.current = dirty; }, []);
  const allowNavigation = (next: Page) => {
    if (currentPage.current === 'files' && next !== 'files' && filesDirty.current) {
      if (!window.confirm('共享文件有未保存的修改，确定放弃并离开？')) return false;
      filesDirty.current = false;
    }
    return true;
  };
  function navigate(next: Page, target?: Selection, replace = false) {
    if (!allowNavigation(next)) return false;
    const selection = target ?? { sessionId: selected, projectId: selectedProject };
    const url = routeUrl(next, selection);
    if (url !== currentUrl.current) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    currentUrl.current = url;
    if (target) applySelection(target);
    currentPage.current = next;
    setPage(next); setSidebar(false); return true;
  }

  function navigateToArchive(archiveKey: string) {
    const hash = `#archives?archive=${encodeURIComponent(archiveKey)}`;
    const url = window.location.pathname + hash;
    if (url !== currentUrl.current) { window.history.pushState(null, '', url); currentUrl.current = url; }
    currentPage.current = 'archives';
    setPage('archives');
    setSidebar(false);
  }

  const [config, setConfig] = useState<AppConfig | null>(null);
  const refreshConfig = useCallback(() => { void api<AppConfig>('/api/config').then(setConfig).catch(() => {}); }, []);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const { projects, refreshProjects, createProject, updateProject, rebuildSandbox } = useProjects();
  const [selectedProject, setSelectedProject] = useState<string | null>(() => readRoute().explicit ? readRoute().projectId : localStorage.getItem('codex-project'));
  const [selected, setSelected] = useState<string | null>(() => readRoute().explicit ? readRoute().sessionId : localStorage.getItem('codex-session'));
  const archivedProjectAccess = useRef<string | null>(null);
  const [billingSelection, setBillingSelection] = useState<{ blockId: string; turnId: string; itemIds?: string[] } | null>(null);
  useEffect(() => { setBillingSelection(null); }, [selected]);
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [attachments, setAttachments] = useState<{ path: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openFile, setOpenFile] = useState<ProjectFileSelection | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<{ id: string; type: string; title: string; body: string; sessionId: string }[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifDot, setNotifDot] = useState(false);
  useEffect(() => {
    const poll = async () => {
      try { const data = await api<{ id: string; type: string; title: string; body: string; sessionId: string }[]>('/api/notifications'); setNotifications(data); setNotifDot(data.length > 0 && data[0].id !== localStorage.getItem('codex-last-notif')); }
      catch { /* ignore */ }
    };
    poll();
    const timer = setInterval(poll, 10_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!openFile) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenFile(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [openFile]);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const activeId = useRef(selected); activeId.current = selected;
  const activeProjectId = useRef(selectedProject); activeProjectId.current = selectedProject;
  const refreshSessions = useCallback(async () => {
    setSessions(await api<SessionSummary[]>('/api/sessions'));
  }, []);
  // Session mutations and runtime state also change project counts/status.
  const refreshWorkspace = useCallback(async () => {
    await Promise.all([refreshSessions(), refreshProjects()]);
  }, [refreshSessions, refreshProjects]);
  const { session, setSession, connected } = useSessionStream({
    selected, enabled: !loading, onState: refreshWorkspace, onError: setError,
  });
  const project = projects.find(item => item.id === selectedProject) ?? null;
  const { prompt, setPrompt, setSessionDraft, moveToSession } = usePromptDraft(
    selected ? `session:${selected}` : `project:${selectedProject ?? ''}:new`,
  );
  const baseSettings = draftSettings || (config && { ...config.defaults, model: DEFAULT_MODEL });
  const storedSettings = session?.settings || (baseSettings && project ? { ...baseSettings, executionMode: project.executionMode, workingDirectory: project.workingDirectory, networkAccessEnabled: draftSettings?.networkAccessEnabled ?? true } : baseSettings);
  const settings = storedSettings ? effectiveSettings(storedSettings) : storedSettings;
  const visibleSessions = selectedProject ? sessions.filter(item => item.projectId === selectedProject) : [];
  const activeSessions = visibleSessions.filter(item => !isArchived(item));
  const archivedSessions = visibleSessions.filter(isArchived).sort((left, right) => Date.parse(archivedAt(right)) - Date.parse(archivedAt(left)));
  const needsProject = !session && !project;
  const running = session?.status === 'running';
  // Native failed turns are execution history rather than user-visible chat.
  // `clientFailure` is injected below only for this browser page's failed POST.
  const conversationTurns = session?.turns.filter(turn => turn.status !== 'failed' || turn.clientFailure) ?? [];
  const archivedSession = Boolean(session && isArchived(session));
  const sandbox = settings?.executionMode === 'sandbox';
  const localReadOnly = Boolean(config?.sandbox?.enabled && settings && !sandbox);
  function applySelection(target: Selection) {
    if (target.sessionId !== activeId.current || target.projectId !== activeProjectId.current) {
      setSession(null); setDraftSettings(null); setAttachments([]); setOpenFile(null);
    }
    activeId.current = target.sessionId; activeProjectId.current = target.projectId;
    setSelected(target.sessionId); setSelectedProject(target.projectId); setError('');
  }
  useEffect(() => {
    const update = () => {
      const url = window.location.pathname + window.location.search + window.location.hash;
      if (url === currentUrl.current) return;
      const route = readRoute();
      if (!allowNavigation(route.page)) { window.history.replaceState(null, '', currentUrl.current); return; }
      currentUrl.current = url; currentPage.current = route.page; setPage(route.page); setSidebar(false);
      if (loading) return; // Bootstrap resolves the latest URL after loading project/session records.
      const target = resolveSelection(route, sessions, projects);
      applySelection(target); setError(target.error ?? '');
      if (!target.error) {
        const canonical = routeUrl(route.page, target);
        window.history.replaceState(null, '', canonical); currentUrl.current = canonical;
      }
    };
    window.addEventListener('popstate', update); window.addEventListener('hashchange', update);
    return () => { window.removeEventListener('popstate', update); window.removeEventListener('hashchange', update); };
  }, [loading, sessions, projects]);
  useEffect(() => {
    if (selectedProject) localStorage.setItem('codex-project', selectedProject); else localStorage.removeItem('codex-project');
  }, [selectedProject]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void refreshWorkspace().catch(() => {}); }, 10_000);
    return () => clearInterval(timer);
  }, [refreshWorkspace]);

  useEffect(() => {
    let alive = true;
    Promise.all([api<AppConfig>('/api/config'), api<SessionSummary[]>('/api/sessions'), refreshProjects()]).then(([nextConfig, list, projectList]) => {
      if (!alive) return; setConfig(nextConfig); setSessions(list); setError('');
      const route = readRoute();
      const target = resolveSelection(route, list, projectList);
      applySelection(target); setError(target.error ?? '');
      const nextPage = !target.projectId && !route.explicit && route.page === 'chat' ? 'projects' : route.page;
      currentPage.current = nextPage; setPage(nextPage);
      if (!target.error) {
        const url = routeUrl(nextPage, target);
        window.history.replaceState(null, '', url); currentUrl.current = url;
      }
    }).catch(err => { if (alive) setError(message(err)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (!loading) followOutput.current = true; }, [selected, loading]);
  useEffect(() => { if (followOutput.current && scrollArea.current) scrollArea.current.scrollTop = scrollArea.current.scrollHeight; }, [session]);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`; } }, [prompt]);
  function selectSession(id: string | null) {
    const projectId = id ? sessions.find(item => item.id === id)?.projectId ?? selectedProject : selectedProject;
    const target = projects.find(item => item.id === projectId);
    if (target && (target.status ?? (target.archivedAt ? 'archived' : 'active')) !== 'active' && archivedProjectAccess.current !== target.id) {
      setError('项目未处于使用中状态，请先在项目管理中恢复。');
      navigate('projects', { projectId: null, sessionId: null });
      return;
    }
    navigate('chat', { sessionId: id, projectId });
  }
  function openProject(id: string, allowArchived = false) {
    const target = projects.find(item => item.id === id);
    if (target && (target.status ?? (target.archivedAt ? 'archived' : 'active')) !== 'active' && !allowArchived) {
      setError('项目未处于使用中状态，请先在项目管理中恢复。');
      navigate('projects', { projectId: null, sessionId: null });
      return;
    }
    archivedProjectAccess.current = target?.status === 'archived' ? id : null;
    navigate('chat', { projectId: id, sessionId: null });
  }
  function returnToChat() {
    const target = projects.find(item => item.id === selectedProject);
    if (target && (target.status ?? (target.archivedAt ? 'archived' : 'active')) !== 'active' && archivedProjectAccess.current !== target.id) {
      const active = projects.find(item => (item.status ?? (item.archivedAt ? 'archived' : 'active')) === 'active');
      navigate('chat', { projectId: active?.id ?? null, sessionId: null });
      return;
    }
    navigate('chat');
  }
  async function openImprovementSession(id: string) {
    const target = await api<Session>(`/api/sessions/${encodeURIComponent(id)}`);
    if (currentPage.current !== 'improvements') return;
    if (navigate('chat', { sessionId: target.id, projectId: target.projectId ?? null })) setSession(target);
  }
  async function ensureSession(): Promise<Session> {
    if (session) return session;
    if (!project) throw new Error('请先创建或选择一个项目');
    const created = await api<Session>('/api/sessions', { method: 'POST', body: JSON.stringify({ projectId: project.id, settings }) });
    moveToSession(created.id);
    if (activeProjectId.current === project.id && activeId.current === selected) {
      navigate(currentPage.current, { sessionId: created.id, projectId: project.id }, true); setSession(created);
    }
    await refreshWorkspace(); return created;
  }
  async function send() {
    if (!prompt.trim() || busy || running || archivedSession || localReadOnly || needsProject || !config || (selected && !session)) return;
    const submittedPrompt = prompt.trim();
    const submittedImages = attachments.map(attachment => attachment.path);
    let target: Session | null = null;
    setBusy(true); setError('');
    try {
      target = await ensureSession();
      await api(`/api/sessions/${target.id}/turns`, { method: 'POST', body: JSON.stringify({ prompt: submittedPrompt, images: submittedImages }) });
      setSessionDraft(target.id, ''); setAttachments([]); followOutput.current = true; await refreshWorkspace();
    } catch (err) {
      const reason = message(err);
      // This did not become Codex history: preserve it in browser memory so the
      // user can see exactly which submission failed and why, until reload.
      if (target) {
        const failedAt = new Date().toISOString();
        const failedId = `client-failure-${crypto.randomUUID()}`;
        setSession(current => {
          const base = current?.id === target!.id ? current : target!;
          if (base.turns.some(turn => turn.id === failedId)) return base;
          return { ...base, turns: [...base.turns, {
            id: failedId, clientFailure: true, prompt: submittedPrompt, images: submittedImages,
            status: 'failed', items: [], error: reason, startedAt: failedAt, completedAt: failedAt,
          }] };
        });
        followOutput.current = true;
      }
      setError(reason);
    } finally { setBusy(false); }
  }
  async function stop() { if (!session) return; setBusy(true); try { await api(`/api/sessions/${session.id}/stop`, { method: 'POST' }); } catch (err) { setError(message(err)); } finally { setBusy(false); } }
  async function changeModel(model: string) {
    if (!settings || busy || running || archivedSession || localReadOnly || (selected && !session)) throw new Error('当前无法切换模型，请等待会话就绪。');
    setBusy(true);
    try {
      if (session) {
        const id = session.id;
        const updated = await api<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ settings: { model } }) });
        if (activeId.current === id) setSession(updated);
      } else setDraftSettings({ ...settings, model });
    } finally { setBusy(false); }
  }
  async function upload(files: FileList | null) {
    if (!files?.length || archivedSession) return;
    if (files.length + attachments.length > 5) { setError('每条消息最多添加 5 张图片。'); return; }
    if (Array.from(files).some(file => file.size === 0 || file.size > 10 * 1024 * 1024)) { setError('图片大小须在 1 字节到 10 MB 之间。'); return; }
    setBusy(true); setError('');
    try { const current = await ensureSession(); const uploaded: { path: string; name: string }[] = []; for (const file of Array.from(files)) { const data = new FormData(); data.append('image', file); uploaded.push(await api<{ path: string; name: string }>(`/api/sessions/${current.id}/images`, { method: 'POST', body: data })); } setAttachments(prev => [...prev, ...uploaded]); }
    catch (err) { setError(message(err)); } finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function saveSettings(next: Settings, threadId: string, title: string) {
    if (threadId.trim()) { const created = await api<Session>('/api/sessions', { method: 'POST', body: JSON.stringify({ ...(project ? { projectId: project.id } : {}), settings: next, threadId: threadId.trim(), title: title || '导入的 Codex 会话' }) }); selectSession(created.id); setSession(created); }
    else if (session) { const updated = await api<Session>(`/api/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ settings: next, title: title.trim() || session.title }) }); setSession(updated); }
    else setDraftSettings(next);
    await refreshWorkspace(); setSettingsOpen(false);
  }
  async function deleteSession() {
    if (!session || running) return; setBusy(true); try { await api(`/api/sessions/${session.id}`, { method: 'DELETE' }); selectSession(null); await refreshWorkspace(); setSettingsOpen(false); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function archiveSessionById(id: string) {
    setBusy(true); setError('');
    try { await api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) }); await refreshWorkspace(); }
    catch (err) { setError(`归档会话失败：${message(err)}`); }
    finally { setBusy(false); }
  }
  async function changeSessionArchived() {
    if (!session || running || busy) return;
    const archived = isArchived(session);
    setBusy(true); setError('');
    try {
      const updated = await api<Session>(`/api/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ archived: !archived }) });
      if (activeId.current === session.id) setSession(updated);
      await refreshWorkspace();
    } catch (err) { setError(`${archived ? '取消归档' : '归档'}会话失败：${message(err)}`); }
    finally { setBusy(false); }
  }
  const contextUsage = session?.contextUsage;
  const baseSuggestions = sandbox ? [ { icon: 'code' as const, title: '创建一个示例项目', text: '在当前 Sandbox 工作目录创建一个简单的 TypeScript 示例项目，并运行验证。' }, { icon: 'terminal' as const, title: '检查运行环境', text: '检查当前 Sandbox 环境的工作目录、已安装工具和运行时版本。' }, { icon: 'folder' as const, title: '查看工作区', text: '查看当前 Sandbox 工作目录的文件，并介绍已有项目；如果目录为空，告诉我。' } ] : [ { icon: 'code' as const, title: '了解这个项目', text: '阅读当前项目，介绍目录结构、技术栈和核心流程。' }, { icon: 'terminal' as const, title: '检查代码质量', text: '检查当前项目的代码，找出潜在 bug，说明原因并提出修复建议。' }, { icon: 'branch' as const, title: '梳理当前改动', text: '查看当前 Git 改动，总结修改内容，并检查是否有遗漏。' } ];

  const suggestions = project?.requirementUrl ? [
    { icon: 'code' as const, title: '阅读需求并产出技术方案', description: '阅读飞书需求，结合业务模块和实际代码整理技术方案。', text: requirementPrompt(project) },
    ...baseSuggestions.slice(1),
  ] : baseSuggestions;

  return <div className="app-shell">
    {sidebar && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
      <div className="brand"><Mark small /><strong>Codex</strong><span className="demo-tag">WEB</span><button className="icon-button mobile-only" onClick={() => setSidebar(false)} aria-label="关闭导航"><Icon name="close" /></button></div>
      <button className="new-session" disabled={busy} onClick={() => project ? selectSession(null) : navigate('projects')}><Icon name="plus" />新建会话<span>↗</span></button>
      <div className="sidebar-label">当前项目</div><ProjectPicker projects={projects} selected={selectedProject} onSelect={openProject} /><button className={`sandbox-nav ${page === 'projects' ? 'active' : ''}`} aria-current={page === 'projects' ? 'page' : undefined} onClick={() => navigate('projects')}><Icon name="folder" />项目管理</button><button className="workspace-button" onClick={() => setSettingsOpen(true)} disabled={!settings || busy}><Icon name="folder" /><span>{settings ? basename(settings.workingDirectory) : '加载中…'}</span><Icon name="chevron" size={12} /></button>
      <button className={`sandbox-nav ${page === 'sandboxes' ? 'active' : ''}`} aria-current={page === 'sandboxes' ? 'page' : undefined} onClick={() => navigate('sandboxes')}><Icon name="panel" />沙箱管理</button>
      <button className={`sandbox-nav ${page === 'connections' ? 'active' : ''}`} aria-current={page === 'connections' ? 'page' : undefined} onClick={() => navigate('connections')}><Icon name="globe" />连接与凭据</button>
      <button className={`sandbox-nav ${page === 'files' ? 'active' : ''}`} aria-current={page === 'files' ? 'page' : undefined} onClick={() => navigate('files')}><Icon name="code" />共享文件</button>
      <button className={`sandbox-nav ${page === 'improvements' ? 'active' : ''}`} aria-current={page === 'improvements' ? 'page' : undefined} onClick={() => navigate('improvements')}><Icon name="chat" />改进建议</button>
      <button className={`sandbox-nav ${page === 'archives' ? 'active' : ''}`} aria-current={page === 'archives' ? 'page' : undefined} onClick={() => navigate('archives')}><Icon name="folder" />归档管理</button>
      <div className="sidebar-label history-label">项目会话<span>{activeSessions.length}</span></div>
      <nav className="session-list" aria-label="任务历史">{activeSessions.map(item => <div key={item.id} className={`session-row ${page === 'chat' && selected === item.id ? 'active' : ''}`}><button disabled={busy} className="session-link" onClick={() => selectSession(item.id)}><Icon name="chat" size={15} /><span>{item.title}</span>{item.status === 'running' && <span className="running-dot" />}</button><div className="session-menu-wrap"><button className="session-menu-btn" aria-label="会话操作" disabled={busy} onClick={e => { e.stopPropagation(); setSessionMenuOpen(sessionMenuOpen === item.id ? null : item.id); }}><svg width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="3" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="13" r="1.5" fill="currentColor"/></svg></button>{sessionMenuOpen === item.id && <><button className="session-menu-backdrop" onClick={() => setSessionMenuOpen(null)} /><div className="session-menu-dropdown" onClick={() => setSessionMenuOpen(null)}><button className="session-menu-item" disabled={busy} onClick={() => void archiveSessionById(item.id)}>归档会话</button></div></>}</div></div>)}{!loading && !visibleSessions.length && <p className="empty-history">{project ? '此项目还没有会话。' : '创建项目，开始新的工作。'}</p>}{archivedSessions.length > 0 && <details className="archived-sessions"><summary>已归档 <span>{archivedSessions.length}</span></summary>{archivedSessions.map(item => <button key={item.id} disabled={busy} className={`session-link archived ${page === 'chat' && selected === item.id ? 'active' : ''}`} onClick={() => selectSession(item.id)}><Icon name="chat" size={15} /><span>{item.title}</span></button>)}</details>}</nav>
      <div className="sidebar-footer"><button onClick={() => setSettingsOpen(true)} disabled={!settings || busy}><Icon name="settings" /><span>设置与连接</span></button><div className="runtime-label"><span className={config ? 'connection-dot' : 'offline-dot'} />{config ? `Codex App Server · ${config.codexVersion}` : '正在连接服务'}<span>TS</span></div></div>
    </aside>
    {page === 'improvements' ? <ImprovementsPage onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} onOpenSession={openImprovementSession} /> : page === 'archives' ? <ArchiveBrowser onBack={() => navigate('chat')} /> : page === 'connections' ? <ConnectionsPage onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} /> : page === 'files' ? <SharedFilesPage onMenu={() => setSidebar(true)} onDirtyChange={updateFilesDirty} /> : page === 'projects' ? <ProjectsPage projects={projects} config={config} loading={loading} onRefresh={refreshProjects} onCreate={createProject} onUpdate={updateProject} onRebuildSandbox={rebuildSandbox} onOpenProject={id => openProject(id, true)} onViewArchive={navigateToArchive} onMenu={() => setSidebar(true)} onBack={returnToChat} /> : page === 'sandboxes' ? <SandboxManager config={config} onOpenProject={openProject} onOpenSession={selectSession} onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} /> : <main className="main-pane">
      <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={() => setSidebar(true)}><Icon name="menu" /></button><div className="breadcrumbs"><span title={project ? projectDisplayName(project) : undefined}>{project ? projectDisplayName(project) : (settings ? basename(settings.workingDirectory) : 'Codex')}</span><span className="slash">/</span><strong>{session?.title || '新建会话'}</strong></div><div className="topbar-actions"><div className="notif-bell-wrapper"><button className="icon-button notif-bell" aria-label="消息通知" onClick={() => { setNotifOpen(!notifOpen); if (notifDot && notifications.length > 0) { localStorage.setItem('codex-last-notif', notifications[0].id); setNotifDot(false); } }}>{notifDot && <span className="notif-dot" />}<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg></button>{notifOpen && <><button className="session-menu-backdrop" onClick={() => setNotifOpen(false)} /><div className="notif-dropdown"><div className="notif-dropdown-header">消息通知</div><div className="notif-dropdown-body">{notifications.length === 0 ? <p className="notif-empty">暂无消息</p> : notifications.slice(0, 20).map(n => <button key={n.id} className="notif-item" onClick={() => { setNotifOpen(false); selectSession(n.sessionId); }}><span className={`notif-type-badge ${n.type.startsWith('approval') ? 'approval' : 'turn'}`}>{n.type.startsWith('approval') ? '审批' : n.type === 'turn_completed' ? '完成' : n.type === 'turn_failed' ? '失败' : '停止'}</span><span className="notif-title">{n.title}</span><span className="notif-body">{n.body}</span></button>)}</div></div></>}</div></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误"><Icon name="close" size={15} /></button></div>}
      {project && <div className="project-context"><strong>{projectDisplayName(project)}</strong>{project.archivedAt && <span>已归档 · 仅从已归档页签进入</span>}<span>共享项目工作区 · 独立会话上下文</span>{project.requirementUrl ? <><a href={project.requirementUrl} target="_blank" rel="noopener noreferrer">飞书需求 ↗</a>{project.requirementStatus && <span className="project-context-status">飞书项目：{project.requirementStatus}</span>}</> : <span>未关联飞书需求</span>}</div>}
      {session && <div className="session-context"><span>对话开始于 <time dateTime={session.startedAt}>{dateTime(session.startedAt)}</time></span>{isArchived(session) && <span>归档于 <time dateTime={archivedAt(session)}>{dateTime(archivedAt(session))}</time></span>}</div>}
      {archivedSession && <div className="session-archive-notice" role="status">此会话已归档。如需继续工作，请先取消归档。</div>}
      {localReadOnly && <div className="project-run-note" role="status">本机会话仅供查看历史。请在 Sandbox 项目中创建会话继续工作。<button onClick={() => navigate('projects')}>打开项目管理 ↗</button></div>}
      {needsProject && <div className="project-run-note">先创建或选择项目，再开始新的会话。<button onClick={() => navigate('projects')}>打开项目管理 ↗</button></div>}
      <div className="content-layout">{session && <BillingRail sessionId={session.id} turns={conversationTurns} selectedBlockId={billingSelection?.blockId} onSelectBlock={(blockId, turnId, itemIds) => { const targetId = blockId.endsWith(':input') ? itemIds?.at(-1) : itemIds?.[0]; setBillingSelection({ blockId, turnId, itemIds: targetId ? [targetId] : [] }); followOutput.current = false; document.getElementById(`turn-${turnId}-item-${targetId}`)?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }} />}<section className="conversation">
        <div className="conversation-scroll" ref={scrollArea} onScroll={() => { const el = scrollArea.current; if (el) followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
          {!conversationTurns.length ? <div className="welcome"><div className="welcome-eyebrow"><span className="connection-dot" />YOUR WORKSPACE, WITH AN AGENT</div><Mark /><h1>一起，把想法变成代码。</h1><p>{sandbox ? <>Codex 在独立的 Sandbox 环境中阅读、编写和运行代码。<br />本项目的会话共享文件和已安装工具，可以继续已有工作或克隆仓库。</> : <>让 Codex 阅读项目、编写代码、执行命令。<br />从一个任务开始，所有进展都在这里。</>}</p><div className="suggestions">{suggestions.map(item => <button key={item.title} onClick={() => { setPrompt(item.text); textarea.current?.focus(); }}><Icon name={item.icon} size={20} /><strong>{item.title}</strong><span>{"description" in item ? item.description : item.text}</span><span className="suggestion-arrow">↗</span></button>)}</div></div> : <div className="turn-list">{session && conversationTurns.map(turn => <article key={turn.id} id={`turn-${turn.id}`} className="turn"><div id={`turn-${turn.id}-item-user-input`} className={`user-message${billingSelection?.turnId === turn.id && billingSelection.itemIds?.includes('user-input') ? ' billing-item-selected' : ''}`}><p>{turn.prompt}</p><TurnContextStatus turn={turn} /><time className="message-time user-time" dateTime={turn.startedAt}>{dateTime(turn.startedAt)}</time>{turn.images.length > 0 && <div className="sent-images">{turn.images.map((path, i) => <span key={i}><Icon name="attach" size={13} />{basename(path)}</span>)}</div>}</div><div className="assistant-header"><Mark small /><strong>Codex</strong><span>{turn.clientFailure ? '连接失败（未提交给 Codex）' : turn.status === 'running' ? turn.approvals?.some(approval => approval.status === 'pending') ? '等待用户确认' : '正在处理你的任务' : statusLabels[turn.status]}</span>{turn.completedAt && <time className="message-time" dateTime={turn.completedAt}>{dateTime(turn.completedAt)}</time>}</div><div className="turn-items"><TurnItems highlightedItemIds={billingSelection?.turnId === turn.id ? billingSelection.itemIds : undefined} turn={turn} sessionId={session.id} projectId={session.settings.executionMode === 'sandbox' ? session.projectId : undefined} workingDirectory={session.settings.workingDirectory} onOpenFile={file => { if (session.projectId) setOpenFile({ ...file, projectId: session.projectId, workingDirectory: session.settings.workingDirectory }); }} onApprovalResolved={resolved => setSession(current => mergeApprovalDecision(current, session.id, turn.id, resolved))} />{turn.error && <div className="inline-error">{turn.error}</div>}<TurnProgress turn={turn} />{turn.status === 'cancelled' && <div className="muted turn-note">任务已停止，可以继续发送消息。</div>}</div>{turn.usage && <div className="usage">输入 {turn.usage.input_tokens.toLocaleString()} · 输出 {turn.usage.output_tokens.toLocaleString()} tokens · 缓存 {turn.usage.cached_input_tokens.toLocaleString()}</div>}</article>)}</div>}
        </div>
        <div className="composer-area"><div className={`composer ${running ? 'is-running' : ''}`}>{attachments.length > 0 && <div className="attachments">{attachments.map((item, index) => <span key={item.path}><Icon name="attach" size={13} />{item.name}<button aria-label={`移除 ${item.name}`} onClick={() => setAttachments(items => items.filter((_, i) => i !== index))}><Icon name="close" size={12} /></button></span>)}</div>}<textarea ref={textarea} disabled={busy || archivedSession || localReadOnly} aria-label="任务描述" placeholder={archivedSession ? '会话已归档，取消归档后可继续对话…' : running ? 'Codex 正在工作，完成后可继续对话…' : '描述任务，或提出一个问题…'} value={prompt} rows={2} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="composer-toolbar"><div className="composer-options"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => void upload(event.target.files)} /><button className="icon-button" aria-label="添加图片" title="添加图片" disabled={busy || running || archivedSession || localReadOnly || needsProject || !config || Boolean(selected && !session)} onClick={() => fileInput.current?.click()}><Icon name="plus" size={20} /></button><span className="toolbar-separator" /><ModelPicker key={selected || selectedProject || "new"} model={settings?.model || DEFAULT_MODEL} effort={settings?.modelReasoningEffort || "medium"} disabled={!settings || busy || running || archivedSession || localReadOnly || Boolean(selected && !session)} onChange={changeModel} /></div>{running ? <button className="send-button stop-button" aria-label="停止任务" title="停止任务" disabled={busy} onClick={() => void stop()}><Icon name="stop" size={18} /></button> : <button className="send-button" aria-label="发送任务" title="发送任务 (Enter)" disabled={busy || archivedSession || localReadOnly || needsProject || !config || !prompt.trim() || Boolean(selected && !session)} onClick={() => void send()}>{busy ? <span className="spinner" /> : <Icon name="arrow" size={20} />}</button>}</div></div><div className="composer-meta"><button onClick={() => setSettingsOpen(true)} disabled={!settings || busy}><Icon name="folder" size={12} /><span>{settings ? basename(settings.workingDirectory) : '工作目录'}</span><span className="meta-dot">·</span><span>{sandbox ? 'Sandbox · 沙箱内完全访问' : settings?.sandboxMode === 'read-only' ? '只读沙箱' : settings?.sandboxMode === 'workspace-write' ? '工作区可写' : '完全访问'}</span></button><span title="最近一次已完成模型请求的输入 token 数；下一次请求会更新。">{contextUsage ? `上下文 ${contextUsage.inputTokens.toLocaleString()} tokens${contextUsage.cachedInputTokens !== undefined ? ` · 缓存 ${contextUsage.cachedInputTokens.toLocaleString()}` : ''}` : '上下文将在首次模型响应后显示'}</span></div></div>
      </section></div>
    </main>}
    {openFile && <WorkspaceFileView file={openFile} onOpenFile={setOpenFile} onClose={() => setOpenFile(null)} />}
    {settingsOpen && settings && <SettingsModal project={project} settings={settings} session={session} config={config} onClose={() => setSettingsOpen(false)} onSave={saveSettings} onDelete={deleteSession} />}
  </div>;
}
