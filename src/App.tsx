import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ThreadItem } from '@openai/codex-sdk';
import type { AppConfig, Changes, ProjectSummary, RetryState, Session, SessionSummary, Settings, StreamMessage, Turn } from '../shared/types';
import { applySdkEvent } from '../shared/session-events';
import ToolDetails from './ToolDetails';
import RawToolMessages from './RawToolMessages';
import SandboxManager from './SandboxManager';
import ProjectsPage from './ProjectsPage';
import SharedFilesPage from './SharedFilesPage';
import TemplatesPage from './TemplatesPage';
import ConnectionsPage from './ConnectionsPage';
import Markdown from './Markdown';

type IconName = 'plus' | 'chat' | 'folder' | 'chevron' | 'settings' | 'panel' | 'arrow' | 'attach' | 'close' | 'terminal' | 'check' | 'globe' | 'code' | 'branch' | 'stop' | 'menu' | 'refresh' | 'trash';
const paths: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />, chat: <path d="M5 4h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 3V6a2 2 0 0 1 2-2Z" />,
  folder: <path d="M3 7V5h6l2 2h10v13H3V7Z" />, chevron: <path d="m9 5 7 7-7 7" />, settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></>, arrow: <path d="M12 19V5m-6 6 6-6 6 6" />, attach: <path d="m9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8" />,
  close: <path d="m6 6 12 12M6 18 18 6" />, terminal: <><path d="m5 7 5 5-5 5M13 17h6" /></>, check: <path d="m5 12 4 4L19 6" />, globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
  code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" /></>, branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10m12-10c0 6-12 2-12 8" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />, menu: <path d="M4 6h16M4 12h16M4 18h16" />, refresh: <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" /></>, trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></>,
};
function Icon({ name, size = 18 }: { name: IconName; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>; }
function Mark({ small = false }: { small?: boolean }) { return <span className={`codex-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><path d="m18 10-13 14 13 14M30 10l13 14-13 14M28 6 20 42" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>; }
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body as T;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const basename = (path: string) => path.replace(/[\\/]$/, '').split(/[\\/]/).pop() || '工作目录';
const statusLabels: Record<Session['status'], string> = { idle: '就绪', running: '执行中', completed: '已完成', failed: '执行失败', cancelled: '已停止' };

function ItemView({ item, turnStatus, projectId }: { item: ThreadItem; turnStatus: Turn['status']; projectId?: string }) {
  const turnEnded = turnStatus === 'cancelled' || turnStatus === 'failed' || turnStatus === 'completed';
  const endedLabel = turnStatus === 'cancelled' ? '已停止' : turnStatus === 'failed' ? '已中断' : '已结束';
  switch (item.type) {
    case 'agent_message': return <div className="agent-message"><Markdown text={item.text} projectId={projectId} /></div>;
    case 'reasoning': return <details className="reasoning"><summary><span className="tiny-orbit" />思考摘要<Icon name="chevron" size={12} /></summary><Markdown text={item.text} projectId={projectId} /></details>;
    case 'command_execution': return <details className={`tool-card ${item.status === 'in_progress' && turnEnded ? 'ended' : item.status}`}><summary><Icon name="terminal" /><span className="tool-label">运行命令</span><code className="command-preview">{item.command}</code><span className="tool-state">{item.status === 'in_progress' ? (turnEnded ? endedLabel : <span className="spinner" />) : item.exit_code === 0 ? <Icon name="check" size={14} /> : `exit ${item.exit_code ?? '—'}`}</span><Icon name="chevron" size={13} /></summary><pre className="terminal-output">$ {item.command}{'\n\n'}{item.aggregated_output || (item.status === 'in_progress' && !turnEnded ? '等待命令输出…' : '（无输出）')}</pre><ToolDetails item={item} /></details>;
    case 'file_change': return <details className={`tool-card ${item.status}`} open><summary><Icon name="code" /><span>修改了 {item.changes.length} 个文件</span><span className="tool-state">{item.status === 'failed' ? '失败' : <Icon name="check" size={14} />}</span><Icon name="chevron" size={13} /></summary><div className="file-list">{item.changes.map((change, i) => <div key={i}><span className={`file-badge ${change.kind}`}>{change.kind === 'add' ? '+' : change.kind === 'delete' ? '−' : 'M'}</span><code>{change.path}</code></div>)}</div><ToolDetails item={item} /></details>;
    case 'mcp_tool_call': return <details className={`tool-card ${item.status === 'in_progress' && turnEnded ? 'ended' : item.status}`}><summary><Icon name="code" /><span>{item.server} / {item.tool}</span><span className="tool-state">{item.status === 'in_progress' ? (turnEnded ? endedLabel : <span className="spinner" />) : item.status === 'failed' ? '失败' : <Icon name="check" size={14} />}</span><Icon name="chevron" size={13} /></summary><ToolDetails item={item} /></details>;
    case 'web_search': return <details className="tool-card"><summary><Icon name="globe" /><span>搜索网页</span><span className="muted">{item.query}</span></summary><ToolDetails item={item} /></details>;
    case 'todo_list': return <div className="todo-list">{item.items.map((todo, i) => <div key={i} className={todo.completed ? 'done' : ''}><span className="todo-check">{todo.completed && <Icon name="check" size={12} />}</span>{todo.text}</div>)}</div>;
    case 'error': return <div className="inline-error">{item.message}</div>;
  }
  // Native Codex can emit item types before the SDK's TypeScript union includes them.
  const unknownItem = item as { type: string; status?: string };
  return <details className="tool-card"><summary><Icon name="code" /><span>{unknownItem.type}</span><span className="tool-state">{unknownItem.status || ''}</span><Icon name="chevron" size={13} /></summary><ToolDetails item={item} /></details>;
}
function RetryProgress({ retry }: { retry: RetryState }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (retry.status !== 'waiting') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retry.nextRetryAt, retry.status]);
  const deadline = Date.parse(retry.nextRetryAt);
  const seconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
  const label = retry.status === 'retrying' ? '正在重试模型请求'
    : seconds > 0 ? `模型繁忙，${seconds} 秒后重试` : '模型繁忙，等待重试开始';
  return <div className="working-indicator" role="status"><span className="spinner" />{label}（{retry.attempt}/{retry.maxRetries}）</div>;
}
function TurnProgress({ turn }: { turn: Turn }) {
  if (turn.phase === 'finalizing') return <div className="muted turn-note" role="status">{turn.status === 'completed' ? '回复已完成，正在结束任务…' : '正在结束任务…'}</div>;
  if (turn.status !== 'running') return null;
  if (turn.retry) return <RetryProgress retry={turn.retry} />;
  const commandRunning = turn.items.some(item => item.type === 'command_execution' && item.status === 'in_progress');
  const toolRunning = turn.items.some(item => item.type === 'mcp_tool_call' && item.status === 'in_progress');
  const hasReply = turn.items.some(item => item.type === 'agent_message' && item.text.trim());
  const label = turn.phase === 'starting' ? '正在准备本轮 Codex 任务…'
    : commandRunning ? '正在执行命令…'
      : toolRunning ? '正在调用工具…'
        : !turn.phase ? '正在处理任务…'
          : hasReply ? '正在继续处理任务…' : '正在生成回复…';
  return <div className="working-indicator" role="status"><span className="spinner" />{label}</div>;
}
function applyStream(current: Session | null, data: StreamMessage): Session | null {
  if (data.type === 'snapshot' || data.type === 'state') return data.session;
  if (!current) return current;
  return applySdkEvent(current, data.turnId, data.event);
}

function effectiveSettings(settings: Settings): Settings {
  return settings.executionMode === 'e2b' ? { ...settings, sandboxMode: 'danger-full-access', networkAccessEnabled: true } : settings;
}

export default function App() {
  type Page = 'chat' | 'sandboxes' | 'projects' | 'files' | 'templates' | 'connections';
  const route = (): Page => window.location.hash === '#sandboxes' ? 'sandboxes' : window.location.hash === '#projects' ? 'projects' : window.location.hash === '#files' ? 'files' : window.location.hash === '#templates' ? 'templates' : window.location.hash === '#connections' ? 'connections' : 'chat';
  const [page, setPage] = useState<Page>(route);
  const currentPage = useRef(page); currentPage.current = page;
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
  useEffect(() => {
    const update = () => {
      const next = route();
      if (allowNavigation(next)) { currentPage.current = next; setPage(next); }
      else window.history.replaceState(null, '', `#${currentPage.current}`);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  function navigate(next: Page) {
    if (!allowNavigation(next)) return false;
    currentPage.current = next; window.location.hash = next === 'chat' ? '' : next;
    setPage(next); setSidebar(false); return true;
  }

  const [config, setConfig] = useState<AppConfig | null>(null);
  const refreshConfig = useCallback(() => { void api<AppConfig>('/api/config').then(setConfig).catch(() => {}); }, []);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(() => localStorage.getItem('codex-project'));
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('codex-session'));
  const [session, setSession] = useState<Session | null>(null);
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<{ path: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
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
  const project = projects.find(item => item.id === selectedProject) ?? null;
  const baseSettings = draftSettings || config?.defaults;
  const storedSettings = session?.settings || (baseSettings && project ? { ...baseSettings, executionMode: project.executionMode, workingDirectory: project.workingDirectory, networkAccessEnabled: draftSettings?.networkAccessEnabled ?? true } : baseSettings);
  const settings = storedSettings ? effectiveSettings(storedSettings) : storedSettings;
  const visibleSessions = selectedProject ? sessions.filter(item => item.projectId === selectedProject) : [];
  const needsProject = !session && !project;
  const running = session?.status === 'running';
  const e2b = settings?.executionMode === 'e2b';
  const localReadOnly = Boolean(config?.e2b?.enabled && settings && !e2b);
  const refreshSessions = useCallback(async () => {
    const [list, projectList] = await Promise.all([api<SessionSummary[]>('/api/sessions'), api<ProjectSummary[]>('/api/projects')]);
    setSessions(list); setProjects(projectList);
  }, []);
  useEffect(() => {
    if (selectedProject) localStorage.setItem('codex-project', selectedProject); else localStorage.removeItem('codex-project');
  }, [selectedProject]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void refreshSessions().catch(() => {}); }, 10_000);
    return () => clearInterval(timer);
  }, [refreshSessions]);

  useEffect(() => {
    let alive = true;
    Promise.all([api<AppConfig>('/api/config'), api<SessionSummary[]>('/api/sessions'), api<ProjectSummary[]>('/api/projects')]).then(([nextConfig, list, projectList]) => {
      if (!alive) return; setConfig(nextConfig); setSessions(list); setProjects(projectList); setError('');
      const current = list.find(item => item.id === localStorage.getItem('codex-session') && projectList.some(project => project.id === item.projectId));
      const nextProject = current?.projectId ?? projectList.find(item => item.id === localStorage.getItem('codex-project'))?.id ?? projectList.find(item => !item.archivedAt)?.id ?? projectList[0]?.id ?? null;
      setSelectedProject(nextProject);
      setSelected(current?.id ?? null);
      if (!nextProject && route() === 'chat') navigate('projects');
    }).catch(err => { if (alive) setError(message(err)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    // Validate the saved selection before subscribing; legacy local sessions
    // remain stored on the server but must not flash on screen during startup.
    if (loading) return;
    setSession(null); setConnected(false); setChanges(null); followOutput.current = true;
    if (!selected) { localStorage.removeItem('codex-session'); return; }
    localStorage.setItem('codex-session', selected);
    let alive = true;
    const source = new EventSource(`/api/sessions/${selected}/events`);
    source.onopen = () => { if (alive) setConnected(true); };
    source.onerror = () => { if (alive) setConnected(false); };
    source.onmessage = event => {
      if (!alive) return;
      try { const data = JSON.parse(event.data) as StreamMessage; setSession(current => applyStream(current, data)); if (data.type === 'state') void refreshSessions().catch(() => {}); }
      catch { setError('会话事件解析失败，请刷新页面重试。'); }
    };
    // The SSE snapshot is authoritative, while this request surfaces missing sessions/errors.
    api<Session>(`/api/sessions/${selected}`).then(value => { if (alive) setSession(current => current || value); }).catch(err => { if (alive) setError(message(err)); });
    return () => { alive = false; source.close(); };
  }, [selected, loading, refreshSessions]);
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
    if (!navigate('chat')) return; if (id !== selected) setSession(null); setSelected(id); setDraftSettings(null); setPrompt(''); setAttachments([]); setError(''); setSidebar(false);
    if (id) { const target = sessions.find(item => item.id === id); if (target) setSelectedProject(target.projectId ?? null); }
  }
  function openProject(id: string) { if (!navigate('chat')) return; setSelectedProject(id); selectSession(null); }
  async function ensureSession(): Promise<Session> {
    if (session) return session;
    if (!project) throw new Error('请先创建或选择一个项目');
    const created = await api<Session>('/api/sessions', { method: 'POST', body: JSON.stringify({ projectId: project.id, settings }) });
    setSelected(created.id); setSession(created); await refreshSessions(); return created;
  }
  async function send() {
    if (!prompt.trim() || busy || running || localReadOnly || needsProject || !config || (selected && !session)) return;
    setBusy(true); setError('');
    try { const current = await ensureSession(); await api(`/api/sessions/${current.id}/turns`, { method: 'POST', body: JSON.stringify({ prompt: prompt.trim(), images: attachments.map(a => a.path) }) }); setPrompt(''); setAttachments([]); followOutput.current = true; await refreshSessions(); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function stop() { if (!session) return; setBusy(true); try { await api(`/api/sessions/${session.id}/stop`, { method: 'POST' }); } catch (err) { setError(message(err)); } finally { setBusy(false); } }
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
    await refreshSessions(); setSettingsOpen(false);
  }
  async function deleteSession() {
    if (!session || running) return; setBusy(true); try { await api(`/api/sessions/${session.id}`, { method: 'DELETE' }); selectSession(null); await refreshSessions(); setSettingsOpen(false); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  const tokenTotal = session?.turns.reduce((total, turn) => total + (turn.usage?.input_tokens || 0) + (turn.usage?.output_tokens || 0), 0) || 0;
  const suggestions = e2b ? [ { icon: 'code' as const, title: '创建一个示例项目', text: '在当前 E2B 工作目录创建一个简单的 TypeScript 示例项目，并运行验证。' }, { icon: 'terminal' as const, title: '检查运行环境', text: '检查当前 E2B 环境的工作目录、已安装工具和运行时版本。' }, { icon: 'folder' as const, title: '查看工作区', text: '查看当前 E2B 工作目录的文件，并介绍已有项目；如果目录为空，告诉我。' } ] : [ { icon: 'code' as const, title: '了解这个项目', text: '阅读当前项目，介绍目录结构、技术栈和核心流程。' }, { icon: 'terminal' as const, title: '检查代码质量', text: '检查当前项目的代码，找出潜在 bug，说明原因并提出修复建议。' }, { icon: 'branch' as const, title: '梳理当前改动', text: '查看当前 Git 改动，总结修改内容，并检查是否有遗漏。' } ];

  return <div className="app-shell">
    {sidebar && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
      <div className="brand"><Mark small /><strong>Codex</strong><span className="demo-tag">WEB</span><button className="icon-button mobile-only" onClick={() => setSidebar(false)} aria-label="关闭导航"><Icon name="close" /></button></div>
      <button className="new-session" disabled={busy} onClick={() => project ? selectSession(null) : navigate('projects')}><Icon name="plus" />新建会话<span>↗</span></button>
      <div className="sidebar-label">当前项目</div><select className="project-picker" aria-label="当前项目" value={selectedProject || ''} onChange={event => { if (event.target.value) openProject(event.target.value); }}><option value="" disabled hidden>{projects.length ? '请选择项目' : '暂无项目'}</option>{projects.some(item => !item.archivedAt) && <optgroup label="进行中">{projects.filter(item => !item.archivedAt).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}{projects.some(item => item.archivedAt) && <optgroup label="已归档">{projects.filter(item => item.archivedAt).map(item => <option key={item.id} value={item.id}>{item.name}（已归档）</option>)}</optgroup>}</select><button className={`sandbox-nav ${page === 'projects' ? 'active' : ''}`} aria-current={page === 'projects' ? 'page' : undefined} onClick={() => navigate('projects')}><Icon name="folder" />项目管理</button><button className="workspace-button" onClick={() => setSettingsOpen(true)} disabled={!settings || busy}><Icon name="folder" /><span>{settings ? basename(settings.workingDirectory) : '加载中…'}</span><Icon name="chevron" size={12} /></button>
      <button className={`sandbox-nav ${page === 'sandboxes' ? 'active' : ''}`} aria-current={page === 'sandboxes' ? 'page' : undefined} onClick={() => navigate('sandboxes')}><Icon name="panel" />沙箱管理</button>
      <button className={`sandbox-nav ${page === 'templates' ? 'active' : ''}`} aria-current={page === 'templates' ? 'page' : undefined} onClick={() => navigate('templates')}><Icon name="panel" />模板管理</button>
      <button className={`sandbox-nav ${page === 'connections' ? 'active' : ''}`} aria-current={page === 'connections' ? 'page' : undefined} onClick={() => navigate('connections')}><Icon name="globe" />连接与凭据</button>
      <button className={`sandbox-nav ${page === 'files' ? 'active' : ''}`} aria-current={page === 'files' ? 'page' : undefined} onClick={() => navigate('files')}><Icon name="code" />共享文件</button>
      <div className="sidebar-label history-label">项目会话<span>{visibleSessions.length}</span></div>
      <nav className="session-list" aria-label="任务历史">{visibleSessions.map(item => <button key={item.id} disabled={busy} className={`session-link ${page === 'chat' && selected === item.id ? 'active' : ''}`} onClick={() => selectSession(item.id)}><Icon name="chat" size={15} /><span>{item.title}</span>{item.status === 'running' && <span className="running-dot" />}</button>)}{!loading && !visibleSessions.length && <p className="empty-history">{project ? '此项目还没有会话。' : '创建项目，开始新的工作。'}</p>}</nav>
      <div className="sidebar-footer"><button onClick={() => setSettingsOpen(true)} disabled={!settings || busy}><Icon name="settings" /><span>设置与连接</span></button><div className="runtime-label"><span className={config ? 'connection-dot' : 'offline-dot'} />{config ? `Codex SDK · ${config.sdkVersion}` : '正在连接服务'}<span>TS</span></div></div>
    </aside>
    {page === 'connections' ? <ConnectionsPage onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} /> : page === 'templates' ? <TemplatesPage onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} onDirtyChange={updateTemplatesDirty} onDefaultChanged={refreshConfig} /> : page === 'files' ? <SharedFilesPage onMenu={() => setSidebar(true)} onDirtyChange={updateFilesDirty} /> : page === 'projects' ? <ProjectsPage projects={projects} config={config} loading={loading} onRefresh={refreshSessions} onOpenProject={openProject} onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} /> : page === 'sandboxes' ? <SandboxManager onOpenProject={openProject} onOpenSession={selectSession} onMenu={() => setSidebar(true)} onBack={() => navigate('chat')} /> : <main className="main-pane">
      <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={() => setSidebar(true)}><Icon name="menu" /></button><div className="breadcrumbs"><span title={project?.name}>{project?.name || (settings ? basename(settings.workingDirectory) : 'Codex')}</span><span className="slash">/</span><strong>{session?.title || '新建会话'}</strong></div><div className="topbar-actions">{e2b && <span className="execution-badge" title="整个 Codex 在 E2B 沙箱内运行">E2B</span>}{session && <span className="connection-label"><span className={connected ? 'connection-dot' : 'offline-dot'} />{connected ? '已连接' : '重新连接中'}</span>}<button className="raw-tools-toggle" aria-pressed={rawToolsOpen} onClick={() => { setRawToolsOpen(value => !value); setChangesOpen(false); }}><Icon name="code" size={15} />原始工具消息</button><button className={`icon-button ${changesOpen ? 'pressed' : ''}`} title="查看工作区改动" aria-label="查看工作区改动" aria-pressed={changesOpen} onClick={() => { setChangesOpen(value => !value); setRawToolsOpen(false); }}><Icon name="panel" /></button></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误"><Icon name="close" size={15} /></button></div>}
      {project && <div className="project-context"><strong>{project.name}</strong>{project.archivedAt && <span>已归档 · 仍可继续使用</span>}<span>共享项目工作区 · 独立会话上下文</span>{project.requirementUrl ? <a href={project.requirementUrl} target="_blank" rel="noopener noreferrer">飞书需求 ↗</a> : <span>未关联飞书需求</span>}</div>}
      {localReadOnly && <div className="project-run-note" role="status">本机会话仅供查看历史。请在 E2B 项目中创建会话继续工作。<button onClick={() => navigate('projects')}>打开项目管理 ↗</button></div>}
      {needsProject && <div className="project-run-note">先创建或选择项目，再开始新的会话。<button onClick={() => navigate('projects')}>打开项目管理 ↗</button></div>}
      <div className="content-layout"><section className="conversation">
        <div className="conversation-scroll" ref={scrollArea} onScroll={() => { const el = scrollArea.current; if (el) followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
          {!session?.turns.length ? <div className="welcome"><div className="welcome-eyebrow"><span className="connection-dot" />YOUR WORKSPACE, WITH AN AGENT</div><Mark /><h1>一起，把想法变成代码。</h1><p>{e2b ? <>Codex 在独立的 E2B 环境中阅读、编写和运行代码。<br />本项目的会话共享文件和已安装工具，可以继续已有工作或克隆仓库。</> : <>让 Codex 阅读项目、编写代码、执行命令。<br />从一个任务开始，所有进展都在这里。</>}</p><div className="suggestions">{suggestions.map(item => <button key={item.title} onClick={() => { setPrompt(item.text); textarea.current?.focus(); }}><Icon name={item.icon} size={20} /><strong>{item.title}</strong><span>{item.text}</span><span className="suggestion-arrow">↗</span></button>)}</div></div> : <div className="turn-list">{session.turns.map(turn => <article key={turn.id} className="turn"><div className="user-message"><p>{turn.prompt}</p>{turn.images.length > 0 && <div className="sent-images">{turn.images.map((path, i) => <span key={i}><Icon name="attach" size={13} />{basename(path)}</span>)}</div>}</div><div className="assistant-header"><Mark small /><strong>Codex</strong><span>{turn.status === 'running' ? '正在处理你的任务' : statusLabels[turn.status]}</span></div><div className="turn-items">{turn.items.map(item => <ItemView key={item.id} item={item} turnStatus={turn.status} projectId={session.settings.executionMode === 'e2b' && config?.capabilities.sandboxPreviews ? session.projectId : undefined} />)}{turn.error && <div className="inline-error">{turn.error}</div>}<TurnProgress turn={turn} />{turn.status === 'cancelled' && <div className="muted turn-note">任务已停止，可以继续发送消息。</div>}</div>{turn.usage && <div className="usage">输入 {turn.usage.input_tokens.toLocaleString()} · 输出 {turn.usage.output_tokens.toLocaleString()} tokens · 缓存 {turn.usage.cached_input_tokens.toLocaleString()}</div>}</article>)}</div>}
        </div>
        <div className="composer-area"><div className={`composer ${running ? 'is-running' : ''}`}>{attachments.length > 0 && <div className="attachments">{attachments.map((item, index) => <span key={item.path}><Icon name="attach" size={13} />{item.name}<button aria-label={`移除 ${item.name}`} onClick={() => setAttachments(items => items.filter((_, i) => i !== index))}><Icon name="close" size={12} /></button></span>)}</div>}<textarea ref={textarea} disabled={busy || localReadOnly} aria-label="任务描述" placeholder={running ? 'Codex 正在工作，完成后可继续对话…' : '描述任务，或提出一个问题…'} value={prompt} rows={2} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="composer-toolbar"><div className="composer-options"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => void upload(event.target.files)} /><button className="icon-button" aria-label="添加图片" title="添加图片" disabled={busy || running || localReadOnly || needsProject || !config || Boolean(selected && !session)} onClick={() => fileInput.current?.click()}><Icon name="plus" size={20} /></button><span className="toolbar-separator" /><button className="model-button" onClick={() => setSettingsOpen(true)} disabled={!settings || busy}><span>{settings?.model || '本地默认模型'}</span><span className="model-effort">{settings?.modelReasoningEffort || 'medium'}</span><Icon name="chevron" size={11} /></button></div>{running ? <button className="send-button stop-button" aria-label="停止任务" title="停止任务" disabled={busy} onClick={() => void stop()}><Icon name="stop" size={18} /></button> : <button className="send-button" aria-label="发送任务" title="发送任务 (Enter)" disabled={busy || localReadOnly || needsProject || !config || !prompt.trim() || Boolean(selected && !session)} onClick={() => void send()}>{busy ? <span className="spinner" /> : <Icon name="arrow" size={20} />}</button>}</div></div><div className="composer-meta"><button onClick={() => setSettingsOpen(true)} disabled={!settings || busy}><Icon name="folder" size={12} /><span>{settings ? basename(settings.workingDirectory) : '工作目录'}</span><span className="meta-dot">·</span><span>{e2b ? 'E2B · 沙箱内完全访问' : settings?.sandboxMode === 'read-only' ? '只读沙箱' : settings?.sandboxMode === 'workspace-write' ? '工作区可写' : '完全访问'}</span></button><span>{tokenTotal ? `${tokenTotal.toLocaleString()} tokens` : 'Enter 发送 · Shift + Enter 换行'}</span></div></div>
      </section>{rawToolsOpen && <RawToolMessages key={selected || "new"} sessionId={selected} onClose={() => setRawToolsOpen(false)} />}{changesOpen && <aside className="changes-panel"><div className="changes-heading"><h2>工作区改动</h2><button className="icon-button" disabled={!selected || changesLoading} onClick={() => void loadChanges()} aria-label="刷新改动"><Icon name="refresh" size={16} /></button><button className="icon-button" onClick={() => setChangesOpen(false)} aria-label="关闭改动面板"><Icon name="close" size={16} /></button></div>{!selected ? <div className="changes-empty"><Icon name="branch" size={28} /><p>开始任务后查看 Git 改动</p></div> : changesLoading && !changes ? <div className="changes-empty"><span className="spinner" />读取工作区…</div> : changesError || changes?.error ? <div className="inline-error">{changesError || changes?.error}</div> : changes && <><div className="branch-label"><Icon name="branch" size={14} />{changes.branch || 'detached HEAD'}<span>{changes.files.length} 个文件</span></div>{changes.files.length === 0 ? <div className="changes-empty"><Icon name="check" size={26} /><p>工作区没有未提交的改动</p></div> : <><div className="changed-files">{changes.files.map(file => <div key={file.path}><span className="file-badge">{file.status}</span><code title={file.path}>{file.path}</code></div>)}</div><pre className="diff-view">{changes.diff.split('\n').map((line, i) => <span key={i} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>)}</pre></>}</>}</aside>}</div>
    </main>}
    {settingsOpen && settings && <SettingsModal project={project} settings={settings} session={session} config={config} onClose={() => setSettingsOpen(false)} onSave={saveSettings} onDelete={deleteSession} />}
  </div>;
}

function SettingsModal({ project, settings, session, config, onClose, onSave, onDelete }: { project: ProjectSummary | null; settings: Settings; session: Session | null; config: AppConfig | null; onClose: () => void; onSave: (settings: Settings, thread: string, title: string) => Promise<void>; onDelete: () => Promise<void> }) {
  const [values, setValues] = useState(() => effectiveSettings(settings));
  const e2b = values.executionMode === 'e2b';
  const localReadOnly = Boolean(config?.e2b?.enabled && !e2b);
  const sandbox = project?.sandbox || session?.sandbox;
  const [title, setTitle] = useState(session?.title || '');
  const [thread, setThread] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setValues(previous => ({ ...previous, [key]: value }));
  function changeExecutionMode(mode: 'local' | 'e2b') {
    setValues(previous => effectiveSettings({ ...previous, executionMode: mode, networkAccessEnabled: mode === 'e2b', workingDirectory: mode === 'e2b' ? config?.e2b?.workingDirectory || '/home/user/workspace' : config?.localWorkingDirectory || config?.defaults.workingDirectory || previous.workingDirectory }));
    setThread('');
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key === 'Tab') { const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'); if (!focusable?.length) return; const first = focusable[0]; const last = focusable[focusable.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    }
    document.addEventListener('keydown', keydown); return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [busy, onClose]);
  async function submit() { setBusy(true); setError(''); try { await onSave(effectiveSettings(values), e2b ? '' : thread, title); } catch (err) { setError(message(err)); } finally { setBusy(false); } }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialogRef}><header><div><span className="modal-eyebrow">AGENT CONFIGURATION</span><h2 id="settings-title">设置与连接</h2></div><button className="icon-button" aria-label="关闭设置" disabled={busy} onClick={onClose}><Icon name="close" /></button></header><div className="settings-body"><div className="connection-info"><span className="connection-dot" /><div><strong>Codex TypeScript SDK</strong><span>{config?.auth === 'api-key' ? '使用服务端 API Key' : e2b ? '使用服务端提供的 Codex 登录凭据' : '使用本机 Codex 登录与配置'} · v{config?.sdkVersion}</span></div></div><fieldset disabled={busy || localReadOnly || session?.status === 'running'}>{session && <label>任务名称<input value={title} onChange={event => setTitle(event.target.value)} /></label>}<label>执行环境<select aria-label="执行环境" value={values.executionMode || 'local'} disabled={Boolean(session || project)} onChange={event => changeExecutionMode(event.target.value as 'local' | 'e2b')}><option value="local" disabled={Boolean(config?.e2b?.enabled)}>{config?.e2b?.enabled ? '本机 · 历史只读' : '本机 · 在服务端机器运行 Codex'}</option><option value="e2b" disabled={!config?.e2b?.enabled}>E2B · 整个 Codex 在独立沙箱运行</option></select><small>{localReadOnly ? '已启用 E2B 隔离执行，本机会话仅可查看历史。' : project ? '执行环境由项目决定；项目内所有会话共用同一沙箱。' : session ? '已有会话的执行环境固定。' : config?.e2b?.enabled ? '创建项目后，项目内会话共享一个独立沙箱。' : 'E2B 尚未配置，请先在服务端配置 E2B 连接。'}</small></label>{e2b && <div className="settings-note execution-note">项目内会话共享沙箱和工作区，分别保留对话上下文。新项目不会自动复制本机文件。</div>}<label>{e2b ? 'E2B 工作目录' : '工作目录'}<input disabled={Boolean(project)} value={values.workingDirectory} onChange={event => update('workingDirectory', event.target.value)} placeholder="/path/to/project" /><small>{project ? '工作目录由项目固定，所有会话共享此目录。' : e2b ? 'E2B 沙箱内的绝对路径，Codex 和所有工具在该环境中执行。' : '服务端机器上的绝对路径，Agent 在此目录执行任务。'}</small></label><div className="settings-row"><label>模型<input value={values.model} onChange={event => update('model', event.target.value)} placeholder="留空使用本地默认模型" /></label><label>思考强度<select value={values.modelReasoningEffort} onChange={event => update('modelReasoningEffort', event.target.value as Settings['modelReasoningEffort'])}>{['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'].map(value => <option key={value}>{value}</option>)}</select></label></div>{e2b ? <label>Codex 在 E2B 内的权限<input aria-label="Codex 在 E2B 内的权限" value="沙箱内完全访问" readOnly /><small>按 AGENTS.md 约定在项目工作区开展任务，可使用沙箱内的其他目录与开发工具。</small></label> : <label>沙箱权限<select value={values.sandboxMode} onChange={event => update('sandboxMode', event.target.value as Settings['sandboxMode'])}><option value="read-only">只读 · 阅读和分析代码</option><option value="workspace-write">工作区可写 · 编辑项目并执行命令</option><option value="danger-full-access">完全访问 · 不使用文件系统沙箱</option></select></label>}<div className="settings-row"><label>网页搜索<select value={values.webSearchMode} onChange={event => update('webSearchMode', event.target.value as Settings['webSearchMode'])}><option value="disabled">关闭</option><option value="cached">缓存搜索</option><option value="live">实时搜索</option></select></label>{e2b ? <label className="network-label">命令网络访问<input aria-label="命令网络访问" value="已开启" readOnly /><small>沙箱内完全访问模式允许命令联网。</small></label> : <label className="network-label">命令网络访问<button className={`toggle ${values.networkAccessEnabled ? 'enabled' : ''}`} type="button" role="switch" disabled={values.sandboxMode !== 'workspace-write'} aria-checked={values.networkAccessEnabled} aria-label="命令网络访问" onClick={() => update('networkAccessEnabled', !values.networkAccessEnabled)}><span /></button><small>仅工作区可写沙箱下生效；完全访问模式不限制网络。</small></label>}</div><div className="settings-note">当前执行策略为 never：需要审批的操作会被拒绝。SDK 暂不提供交互审批和逐 token 文本事件；页面展示 SDK 返回的任务与工具事件。</div><label className="import-label">恢复已有 Codex 会话<span className="optional">可选，将创建新的网页任务</span><input value={thread} disabled={e2b} onChange={event => setThread(event.target.value)} placeholder={e2b ? 'E2B 不支持导入本机线程' : '粘贴 Codex thread ID'} /><small>{e2b ? '新 E2B 任务无法导入本机线程；已有 E2B 任务可直接在历史中继续对话。' : '恢复本机线程上下文。导入前的消息不会复制到网页历史。'}</small></label></fieldset>{e2b && <div className="sandbox-info"><strong>E2B 沙箱</strong>{sandbox ? <><span>状态：{{ starting: '准备中', ready: '可用', paused: '已暂停', unavailable: '不可用' }[sandbox.status]}</span><span>ID：<code>{sandbox.id}</code></span><span>模板：<code>{sandbox.template}</code></span><span>目录：<code>{sandbox.workingDirectory}</code></span></> : <span>首次执行任务时创建 · 模板 {config?.e2b?.template || '默认'}</span>}</div>}{session?.threadId && <div className="thread-id">Thread <code>{session.threadId}</code></div>}{session?.status === 'running' && <div className="settings-note">任务执行中，完成或停止后可修改设置。</div>}{confirmDelete && <div className="settings-note execution-note" role="alert">{project ? '删除此会话的网页历史。项目沙箱、工作区文件和其他会话会保留。' : '删除此会话的网页历史。'}</div>}{error && <div className="inline-error" role="alert">{error}</div>}</div><footer>{session && session.status !== 'running' && <button className="delete-button" disabled={busy} onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return; } setBusy(true); void onDelete().catch(err => setError(message(err))).finally(() => setBusy(false)); }}><Icon name="trash" size={14} />{confirmDelete ? '确认删除会话' : '删除会话'}</button>}<span className="footer-spacer" /><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || localReadOnly || session?.status === 'running' || !values.workingDirectory.trim()} onClick={() => void submit()}>{busy ? '保存中…' : thread.trim() ? '导入会话' : '保存设置'}</button></footer></div></div>;
}
