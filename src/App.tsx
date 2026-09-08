import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig, Changes, Session, SessionSummary, Settings } from '../shared/types';
import { useProjects } from './features/projects/useProjects';
import { useSessionStream } from './features/chat/useSessionStream';
import { usePromptDraft } from './features/chat/usePromptDraft';
import { requirementPrompt } from './features/projects/requirement-prompt';
import ModelPicker from './features/chat/ModelPicker';
import { DEFAULT_MODEL } from '../shared/models';
import { Icon, Mark } from './components/Icon';
import { api, errorMessage as message } from './lib/api';
import { readRoute, resolveSelection, routeUrl, type Page, type Selection } from './lib/navigation';
import ItemView from './features/chat/ItemView';
import TurnProgress from './features/chat/TurnProgress';
import SettingsModal from './features/chat/SettingsModal';
import { effectiveSettings } from './features/chat/settings';
import RawToolMessages from './features/chat/RawToolMessages';
import SandboxManager from './features/sandboxes/SandboxManager';
import ProjectsPage from './features/projects/ProjectsPage';
import ProjectPicker from './features/projects/ProjectPicker';
import SharedFilesPage from './features/shared-files/SharedFilesPage';
import TemplatesPage from './features/templates/TemplatesPage';
import ConnectionsPage from './features/connections/ConnectionsPage';
import ImprovementsPage from './features/improvements/ImprovementsPage';

const basename = (path: string) => path.replace(/[\\/]$/, '').split(/[\\/]/).pop() || '工作目录';
const statusLabels: Record<Session['status'], string> = { idle: '就绪', running: '执行中', completed: '已完成', failed: '执行失败', cancelled: '已停止' };

export default function App() {
  const [page, setPage] = useState<Page>(() => readRoute().page);
  const currentPage = useRef(page); currentPage.current = page;
  const currentUrl = useRef(window.location.pathname + window.location.search + window.location.hash);
  const filesDirty = useRef(false);
  const templatesDirty = useRef(false);
  const updateFilesDirty = useCallback((dirty: boolean) => { filesDirty.current = dirty; }, []);
  const updateTemplatesDirty = useCallback((dirty: boolean) => { templatesDirty.current = dirty; }, []);
  const allowNavigation = (next: Page) => {
    if (currentPage.current === 'files' && next !== 'files' && filesDirty.current) {
      if (!window.confirm('共享文件有未保存的修改，确定放弃并离开？')) return false;
      filesDirty.current = false;
    }
    if (currentPage.current === 'templates' && next !== 'templates' && templatesDirty.current) {
      if (!window.confirm('模板有未保存的修改，确定放弃并离开？')) return false;
      templatesDirty.current = false;
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

  const [config, setConfig] = useState<AppConfig | null>(null);
  const refreshConfig = useCallback(() => { void api<AppConfig>('/api/config').then(setConfig).catch(() => {}); }, []);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const { projects, refreshProjects, createProject, updateProject } = useProjects();
  const [selectedProject, setSelectedProject] = useState<string | null>(() => readRoute().explicit ? readRoute().projectId : localStorage.getItem('codex-project'));
  const [selected, setSelected] = useState<string | null>(() => readRoute().explicit ? readRoute().sessionId : localStorage.getItem('codex-session'));
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [attachments, setAttachments] = useState<{ path: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [rawToolsOpen, setRawToolsOpen] = useState(false);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState('');
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
  const needsProject = !session && !project;
  const running = session?.status === 'running';
  const e2b = settings?.executionMode === 'e2b';
  const localReadOnly = Boolean(config?.e2b?.enabled && settings && !e2b);
  function applySelection(target: Selection) {
    if (target.sessionId !== activeId.current || target.projectId !== activeProjectId.current) {
      setSession(null); setDraftSettings(null); setAttachments([]);
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
  useEffect(() => {
    if (!loading) { setChanges(null); followOutput.current = true; }
  }, [selected, loading]);
  useEffect(() => { if (followOutput.current && scrollArea.current) scrollArea.current.scrollTop = scrollArea.current.scrollHeight; }, [session]);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`; } }, [prompt]);
  const loadChanges = useCallback(async () => {
    if (!selected) return; const id = selected; setChangesLoading(true); setChangesError('');
    try { const value = await api<Changes>(`/api/sessions/${id}/changes`); if (activeId.current === id) setChanges(value); }
    catch (err) { if (activeId.current === id) setChangesError(message(err)); }
    finally { if (activeId.current === id) setChangesLoading(false); }
  }, [selected]);
  useEffect(() => { if (changesOpen) void loadChanges(); }, [changesOpen, session?.status, loadChanges]);
  function selectSession(id: string | null) {
    navigate('chat', { sessionId: id, projectId: id ? sessions.find(item => item.id === id)?.projectId ?? selectedProject : selectedProject });
  }
  function openProject(id: string) { navigate('chat', { projectId: id, sessionId: null }); }
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
    if (!prompt.trim() || busy || running || localReadOnly || needsProject || !config || (selected && !session)) return;
    setBusy(true); setError('');
    try { const current = await ensureSession(); await api(`/api/sessions/${current.id}/turns`, { method: 'POST', body: JSON.stringify({ prompt: prompt.trim(), images: attachments.map(a => a.path) }) }); setSessionDraft(current.id, ''); setAttachments([]); followOutput.current = true; await refreshWorkspace(); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function stop() { if (!session) return; setBusy(true); try { await api(`/api/sessions/${session.id}/stop`, { method: 'POST' }); } catch (err) { setError(message(err)); } finally { setBusy(false); } }
  async function changeModel(model: string) {
    if (!settings || busy || running || localReadOnly || (selected && !session)) throw new Error('当前无法切换模型，请等待会话就绪。');
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
    if (!files?.length) return;
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
  const tokenTotal = session?.turns.reduce((total, turn) => total + (turn.usage?.input_tokens || 0) + (turn.usage?.output_tokens || 0), 0) || 0;
  const baseSuggestions = e2b ? [ { icon: 'code' as const, title: '创建一个示例项目', text: '在当前 E2B 工作目录创建一个简单的 TypeScript 示例项目，并运行验证。' }, { icon: 'terminal' as const, title: '检查运行环境', text: '检查当前 E2B 环境的工作目录、已安装工具和运行时版本。' }, { icon: 'folder' as const, title: '查看工作区', text: '查看当前 E2B 工作目录的文件，并介绍已有项目；如果目录为空，告诉我。' } ] : [ { icon: 'code' as const, title: '了解这个项目', text: '阅读当前项目，介绍目录结构、技术栈和核心流程。' }, { icon: 'terminal' as const, title: '检查代码质量', text: '检查当前项目的代码，找出潜在 bug，说明原因并提出修复建议。' }, { icon: 'branch' as const, title: '梳理当前改动', text: '查看当前 Git 改动，总结修改内容，并检查是否有遗漏。' } ];

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
      <button className={`sandbox-nav ${page === 'templates' ? 'active' : ''}`} aria-current={page === 'templates' ? 'page' : undefined} onClick={() => navigate('templates')}><Icon name="panel" />模板管理</button>
      <button className={`sandbox-nav ${page === 'connections' ? 'active' : ''}`} aria-current={page === 'connections' ? 'page' : undefined} onClick={() => navigate('connections')}><Icon name="globe" />连接与凭据</button>
      <button className={`sandbox-nav ${page === 'files' ? 'active' : ''}`} aria-current={page === 'files' ? 'page' : undefined} onClick={() => navigate('files')}><Icon name="code" />共享文件</button>
      <button className={`sandbox-nav ${page === 'improvements' ? 'active' : ''}`} aria-current={page === 'improvements' ? 'page' : undefined} onClick={() => navigate('improvements')}><Icon name="chat" />改进建议</button>
      <div className="sidebar-label history-label">项目会话<span>{visibleSessions.length}</span></div>
      <nav className="session-list" aria-label="任务历史">{visibleSessions.map(item => <button key={item.id} disabled={busy} className={`session-link ${page === 'chat' && selected === item.id ? 'active' : ''}`} onClick={() => selectSession(item.id)}><Icon name="chat" size={15} /><span>{item.title}</span>{item.status === 'running' && <span className="running-dot" />}</button>)}{!loading && !visibleSessions.length && <p className="empty-history">{project ? '此项目还没有会话。' : '创建项目，开始新的工作。'}</p>}</nav>
      <div className="sidebar-footer"><button onClick={() => setSettingsOpen(true)} disabled={!settings || busy}><Icon name="settings" /><span>设置与连接</span></button><div className="runtime-label"><span className={config ? 'connection-dot' : 'offline-dot'} />{config ? `Codex SDK · ${config.sdkVersion}` : '正在连接服务'}<span>TS</span></div></div>
    </aside>
    {page === 'improvements' ? <ImprovementsPage onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} onOpenSession={openImprovementSession} /> : page === 'connections' ? <ConnectionsPage onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} /> : page === 'templates' ? <TemplatesPage onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} onDirtyChange={updateTemplatesDirty} onDefaultChanged={refreshConfig} /> : page === 'files' ? <SharedFilesPage onMenu={() => setSidebar(true)} onDirtyChange={updateFilesDirty} /> : page === 'projects' ? <ProjectsPage projects={projects} config={config} loading={loading} onRefresh={refreshProjects} onCreate={createProject} onUpdate={updateProject} onOpenProject={openProject} onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} /> : page === 'sandboxes' ? <SandboxManager onOpenProject={openProject} onOpenSession={selectSession} onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} /> : <main className="main-pane">
      <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={() => setSidebar(true)}><Icon name="menu" /></button><div className="breadcrumbs"><span title={project?.name}>{project?.name || (settings ? basename(settings.workingDirectory) : 'Codex')}</span><span className="slash">/</span><strong>{session?.title || '新建会话'}</strong></div><div className="topbar-actions">{e2b && <span className="execution-badge" title="整个 Codex 在 E2B 沙箱内运行">E2B</span>}{session && <span className="connection-label"><span className={connected ? 'connection-dot' : 'offline-dot'} />{connected ? '已连接' : '重新连接中'}</span>}<button className="raw-tools-toggle" aria-pressed={rawToolsOpen} onClick={() => { setRawToolsOpen(value => !value); setChangesOpen(false); }}><Icon name="code" size={15} />原始工具消息</button><button className={`icon-button ${changesOpen ? 'pressed' : ''}`} title="查看工作区改动" aria-label="查看工作区改动" aria-pressed={changesOpen} onClick={() => { setChangesOpen(value => !value); setRawToolsOpen(false); }}><Icon name="panel" /></button></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误"><Icon name="close" size={15} /></button></div>}
      {project && <div className="project-context"><strong>{project.name}</strong>{project.archivedAt && <span>已归档 · 仍可继续使用</span>}<span>共享项目工作区 · 独立会话上下文</span>{project.requirementUrl ? <a href={project.requirementUrl} target="_blank" rel="noopener noreferrer">飞书需求 ↗</a> : <span>未关联飞书需求</span>}</div>}
      {localReadOnly && <div className="project-run-note" role="status">本机会话仅供查看历史。请在 E2B 项目中创建会话继续工作。<button onClick={() => navigate('projects')}>打开项目管理 ↗</button></div>}
      {needsProject && <div className="project-run-note">先创建或选择项目，再开始新的会话。<button onClick={() => navigate('projects')}>打开项目管理 ↗</button></div>}
      <div className="content-layout"><section className="conversation">
        <div className="conversation-scroll" ref={scrollArea} onScroll={() => { const el = scrollArea.current; if (el) followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
          {!session?.turns.length ? <div className="welcome"><div className="welcome-eyebrow"><span className="connection-dot" />YOUR WORKSPACE, WITH AN AGENT</div><Mark /><h1>一起，把想法变成代码。</h1><p>{e2b ? <>Codex 在独立的 E2B 环境中阅读、编写和运行代码。<br />本项目的会话共享文件和已安装工具，可以继续已有工作或克隆仓库。</> : <>让 Codex 阅读项目、编写代码、执行命令。<br />从一个任务开始，所有进展都在这里。</>}</p><div className="suggestions">{suggestions.map(item => <button key={item.title} onClick={() => { setPrompt(item.text); textarea.current?.focus(); }}><Icon name={item.icon} size={20} /><strong>{item.title}</strong><span>{"description" in item ? item.description : item.text}</span><span className="suggestion-arrow">↗</span></button>)}</div></div> : <div className="turn-list">{session.turns.map(turn => <article key={turn.id} className="turn"><div className="user-message"><p>{turn.prompt}</p>{turn.images.length > 0 && <div className="sent-images">{turn.images.map((path, i) => <span key={i}><Icon name="attach" size={13} />{basename(path)}</span>)}</div>}</div><div className="assistant-header"><Mark small /><strong>Codex</strong><span>{turn.status === 'running' ? '正在处理你的任务' : statusLabels[turn.status]}</span></div><div className="turn-items">{turn.items.map(item => <ItemView key={item.id} item={item} turnStatus={turn.status} projectId={session.settings.executionMode === 'e2b' && config?.capabilities.sandboxPreviews ? session.projectId : undefined} />)}{turn.error && <div className="inline-error">{turn.error}</div>}<TurnProgress turn={turn} />{turn.status === 'cancelled' && <div className="muted turn-note">任务已停止，可以继续发送消息。</div>}</div>{turn.usage && <div className="usage">输入 {turn.usage.input_tokens.toLocaleString()} · 输出 {turn.usage.output_tokens.toLocaleString()} tokens · 缓存 {turn.usage.cached_input_tokens.toLocaleString()}</div>}</article>)}</div>}
        </div>
        <div className="composer-area"><div className={`composer ${running ? 'is-running' : ''}`}>{attachments.length > 0 && <div className="attachments">{attachments.map((item, index) => <span key={item.path}><Icon name="attach" size={13} />{item.name}<button aria-label={`移除 ${item.name}`} onClick={() => setAttachments(items => items.filter((_, i) => i !== index))}><Icon name="close" size={12} /></button></span>)}</div>}<textarea ref={textarea} disabled={busy || localReadOnly} aria-label="任务描述" placeholder={running ? 'Codex 正在工作，完成后可继续对话…' : '描述任务，或提出一个问题…'} value={prompt} rows={2} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="composer-toolbar"><div className="composer-options"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => void upload(event.target.files)} /><button className="icon-button" aria-label="添加图片" title="添加图片" disabled={busy || running || localReadOnly || needsProject || !config || Boolean(selected && !session)} onClick={() => fileInput.current?.click()}><Icon name="plus" size={20} /></button><span className="toolbar-separator" /><ModelPicker key={selected || selectedProject || "new"} model={settings?.model || DEFAULT_MODEL} effort={settings?.modelReasoningEffort || "medium"} disabled={!settings || busy || running || localReadOnly || Boolean(selected && !session)} onChange={changeModel} /></div>{running ? <button className="send-button stop-button" aria-label="停止任务" title="停止任务" disabled={busy} onClick={() => void stop()}><Icon name="stop" size={18} /></button> : <button className="send-button" aria-label="发送任务" title="发送任务 (Enter)" disabled={busy || localReadOnly || needsProject || !config || !prompt.trim() || Boolean(selected && !session)} onClick={() => void send()}>{busy ? <span className="spinner" /> : <Icon name="arrow" size={20} />}</button>}</div></div><div className="composer-meta"><button onClick={() => setSettingsOpen(true)} disabled={!settings || busy}><Icon name="folder" size={12} /><span>{settings ? basename(settings.workingDirectory) : '工作目录'}</span><span className="meta-dot">·</span><span>{e2b ? 'E2B · 沙箱内完全访问' : settings?.sandboxMode === 'read-only' ? '只读沙箱' : settings?.sandboxMode === 'workspace-write' ? '工作区可写' : '完全访问'}</span></button><span>{tokenTotal ? `${tokenTotal.toLocaleString()} tokens` : 'Enter 发送 · Shift + Enter 换行'}</span></div></div>
      </section>{rawToolsOpen && <RawToolMessages key={selected || "new"} sessionId={selected} onClose={() => setRawToolsOpen(false)} />}{changesOpen && <aside className="changes-panel"><div className="changes-heading"><h2>工作区改动</h2><button className="icon-button" disabled={!selected || changesLoading} onClick={() => void loadChanges()} aria-label="刷新改动"><Icon name="refresh" size={16} /></button><button className="icon-button" onClick={() => setChangesOpen(false)} aria-label="关闭改动面板"><Icon name="close" size={16} /></button></div>{!selected ? <div className="changes-empty"><Icon name="branch" size={28} /><p>开始任务后查看 Git 改动</p></div> : changesLoading && !changes ? <div className="changes-empty"><span className="spinner" />读取工作区…</div> : changesError || changes?.error ? <div className="inline-error">{changesError || changes?.error}</div> : changes && <><div className="branch-label"><Icon name="branch" size={14} />{changes.branch || 'detached HEAD'}<span>{changes.files.length} 个文件</span></div>{changes.files.length === 0 ? <div className="changes-empty"><Icon name="check" size={26} /><p>工作区没有未提交的改动</p></div> : <><div className="changed-files">{changes.files.map(file => <div key={file.path}><span className="file-badge">{file.status}</span><code title={file.path}>{file.path}</code></div>)}</div><pre className="diff-view">{changes.diff.split('\n').map((line, i) => <span key={i} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>)}</pre></>}</>}</aside>}</div>
    </main>}
    {settingsOpen && settings && <SettingsModal project={project} settings={settings} session={session} config={config} onClose={() => setSettingsOpen(false)} onSave={saveSettings} onDelete={deleteSession} />}
  </div>;
}
