import { useEffect, useRef, useState } from "react";
import type { NativeEvent, NativeEvents, SdkRun, WorkbenchInfo, Workspace } from "../../src/contracts/native.js";
import { api, json, knownThreads, mergeEvents, object, recoverActiveRequest, runItems, sdkInput, text, workspaceRoute, workspaceUrl, type SdkItemView } from "./sdk-api.js";

export function ItemView({ value }: { value: SdkItemView }) {
  const item = value.item, type = text(item.type);
  let content: string | undefined;
  if (type === "agent_message") content = text(item.text);
  if (type === "command_execution") content = [text(item.command), text(item.aggregated_output)].filter(Boolean).join("\n\n");
  if (type === "file_change") content = json(item.changes);
  if (type === "web_search") content = text(item.query);
  return <article className={`message message-${type}`}><header><strong>{type || "SDK item"}</strong><code>{value.id}</code><small>{text(item.status)}</small></header>{content !== undefined && <pre>{content}</pre>}{type === "todo_list" && Array.isArray(item.items) && <ul>{item.items.map((todo, index) => <li key={index}>{object(todo).completed ? "✓" : "○"} {text(object(todo).text)}</li>)}</ul>}<details open={content === undefined && type !== "todo_list"}><summary>SDK 原始数据</summary><pre>{json(item)}</pre></details></article>;
}

export function RunView({ run, events }: { run: SdkRun; events: NativeEvent[] }) {
  const items = runItems(events, run.requestId);
  return <section className="run"><header><strong>{run.status}</strong><small>传输请求 ID：<code>{run.requestId}</code></small></header><p className="hint">原生 Thread ID：<code>{run.threadId ?? "等待 SDK thread.started"}</code></p><article className="message message-userMessage"><header><strong>用户</strong></header><pre>{typeof run.input === "string" ? run.input : json(run.input)}</pre></article>{items.map(value => <ItemView key={value.id} value={value} />)}{run.error && <p className="error">{run.error}</p>}<details className="debug"><summary>本轮原生 SDK 事件（{events.filter(event => event.requestId === run.requestId).length}）</summary>{events.filter(event => event.requestId === run.requestId).map(event => <details key={event.seq}><summary>#{event.seq} · {text(object(event.event).type) || "未知事件"}</summary><pre>{json(event.event)}</pre></details>)}</details></section>;
}

function WorkspacePane({ initial, onUpdate }: { initial: Workspace; onUpdate: (workspace: Workspace) => void }) {
  const [workspace, setWorkspace] = useState(initial);
  const [opened, setOpened] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(initial.threadId);
  const threadRef = useRef(threadId);
  const [manualThread, setManualThread] = useState("");
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [events, setEvents] = useState<NativeEvent[]>([]);
  const [runs, setRuns] = useState<SdkRun[]>([]);
  const [draft, setDraft] = useState("");
  const [imagePath, setImagePath] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false), alive = useRef(true);
  const [error, setError] = useState<string | null>(null), [pollError, setPollError] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [refresh, setRefresh] = useState(0);
  const cursor = useRef(0), ownRequest = useRef<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const update = () => setVisible(!document.hidden); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  function choose(id: string | null) { threadRef.current = id; setThreadId(id); }
  function updateWorkspace(value: Workspace) { if (!alive.current) return; setWorkspace(value); onUpdate(value); }
  function consume(page: NativeEvents) {
    cursor.current = page.nextAfter;
    setEvents(previous => mergeEvents(previous, page.events));
    setRuns(page.runs);
    setActiveRequestId(page.runs.find(run => run.status === "running")?.requestId ?? null);
    ownRequest.current = recoverActiveRequest(threadRef.current, ownRequest.current, page.runs);
    const own = page.runs.find(run => run.requestId === ownRequest.current);
    if (own?.threadId) choose(own.threadId);
    // Native thread.started is authoritative if the run snapshot has not caught up yet.
    for (const envelope of page.events) if (envelope.requestId === ownRequest.current && envelope.event.type === "thread.started") choose(envelope.event.thread_id);
  }
  async function perform(label: string, action: () => Promise<void>) {
    if (pendingRef.current || !alive.current) return;
    pendingRef.current = true; setPending(label); setError(null);
    try { await action(); }
    catch (reason) { if (alive.current) setError(`${reason instanceof Error ? reason.message : String(reason)}。请求结果不明确时请先读取状态，不会自动重试提交。`); }
    finally { pendingRef.current = false; if (alive.current) setPending(null); }
  }
  useEffect(() => {
    if (!opened || !visible || pending) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try { const page = await api.events(initial.id, cursor.current, controller.signal); if (!controller.signal.aborted) { consume(page); setPollError(null); } }
      catch (reason) { if (!controller.signal.aborted) setPollError(reason instanceof Error ? reason.message : String(reason)); }
      finally { if (!controller.signal.aborted && opened) timer = setTimeout(() => void read(), 1000); }
    }
    void read(); return () => { controller.abort(); clearTimeout(timer); };
  }, [opened, visible, pending, refresh, initial.id]);

  async function open() {
    const result = await api.open(initial.id);
    if (!alive.current) return;
    updateWorkspace(result.workspace); setActiveRequestId(result.health.activeRequestId); setOpened(true);
  }
  async function send() {
    if (activeRequestId) return;
    const input = sdkInput(draft, imagePath), requestId = crypto.randomUUID();
    ownRequest.current = requestId;
    const run = await api.run(initial.id, requestId, input, threadRef.current ?? undefined);
    if (!alive.current) return;
    setRuns(previous => [...previous.filter(value => value.requestId !== run.requestId), run]);
    setActiveRequestId(run.status === "running" ? run.requestId : null);
    if (run.threadId) choose(run.threadId);
    setDraft(""); setImagePath("");
  }
  const locked = !!pending || !!activeRequestId;
  const threads = knownThreads(runs);
  const selectedRuns = runs.filter(run => threadId ? run.threadId === threadId || (run.requestId === ownRequest.current && !run.threadId) : run.requestId === ownRequest.current);
  return <section className="workspace"><header className="workspace-head"><div><h2>{workspace.title}</h2>{workspace.sourceUrl && <p className="source">来源：{workspace.sourceUrl}</p>}<p><code>{workspace.sandboxId ?? "尚未创建沙箱"}</code></p></div><button disabled={!!pending} onClick={() => void perform("打开环境", open)}>{pending === "打开环境" ? "打开中…" : opened ? "重新连接 / 核对" : "打开环境"}</button></header>
    <p className="hint">打开环境只连接 SDK 运行环境，不发送任务；连接 E2B 后读取已记录历史。首次发送才调用 startThread；后续使用原生 Thread ID 调用 resumeThread。</p>
    {error && <p role="alert" className="error">{error}</p>}{pollError && <p role="alert" className="error">历史读取：{pollError} <button disabled={!!pending} onClick={() => setRefresh(value => value + 1)}>重试读取</button></p>}
    <div className="thread-bar"><label>本工作台记录的原生会话<select value={threadId ?? ""} disabled={locked} onChange={event => { ownRequest.current = null; choose(event.target.value || null); }}><option value="">新对话（首次发送时创建）</option>{threadId && !threads.includes(threadId) && <option value={threadId}>{threadId}</option>}{threads.map(id => <option key={id} value={id}>{id}</option>)}</select></label><button disabled={locked} onClick={() => { ownRequest.current = null; choose(null); }}>新对话</button><button disabled={!!pending || !opened} onClick={() => setRefresh(value => value + 1)}>读取最新状态</button></div>
    <div className="thread-bar"><label>或输入已有原生 Thread ID<input value={manualThread} onChange={event => setManualThread(event.target.value)} disabled={locked} placeholder="会话文件需要已存在于当前沙箱" /></label><button disabled={locked || !manualThread.trim()} onClick={() => { ownRequest.current = null; choose(manualThread.trim()); setManualThread(""); }}>选择此会话</button></div>
    <p className="hint">这里不是 SDK 的完整会话目录，仅展示已记录的请求。新对话只改变页面选择，不重启沙箱。传输 requestId 不是原生 turn/thread ID。</p>
    <p className="hint">Thread：<code>{threadId ?? "下一次发送创建"}</code> · {activeRequestId ? <>运行中（传输请求）：<code>{activeRequestId}</code></> : "空闲"}</p>
    <div className="timeline" aria-label="SDK 对话历史">{selectedRuns.length ? selectedRuns.map(run => <RunView key={run.requestId} run={run} events={events} />) : <p className="empty">当前选择没有本地记录。记录用于展示，不会重新拼接成模型上下文。</p>}</div>
    <form className="composer" onSubmit={event => { event.preventDefault(); void perform("发送消息", send); }}><label>消息<textarea rows={5} value={draft} onChange={event => setDraft(event.target.value)} placeholder="原样发送给 Codex SDK，不添加框架任务指令" disabled={locked} /></label><label>沙箱内图片绝对路径（可选，不是 URL 或宿主机路径）<input value={imagePath} onChange={event => setImagePath(event.target.value)} placeholder="/home/user/projects/…/image.png" disabled={locked} /></label><div className="actions"><button type="submit" className="primary" disabled={!opened || locked || (!draft.trim() && !imagePath.trim())}>{pending === "发送消息" ? "发送中…" : "发送"}</button>{activeRequestId && <button type="button" disabled={!!pending} onClick={() => void perform("中断执行", async () => { await api.interrupt(initial.id, activeRequestId); })}>中断当前执行</button>}</div>{activeRequestId && <p className="hint">官方 SDK 不支持执行中的实时补充。本轮结束后再发送，或先中断；不会自动排队。</p>}</form>
    <details className="debug"><summary>全部已记录请求及 SDK 事件（{events.length}）</summary><p className="hint">原生事件类型、item ID 和未知字段均保留。主机历史不是模型上下文，也不由工作台压缩。</p><pre>{json(runs)}</pre>{events.map(event => <details key={event.seq}><summary>#{event.seq} · {text(object(event.event).type)} · {event.requestId}</summary><pre>{json(event)}</pre></details>)}</details>
  </section>;
}

export function App() {
  const [selected, setSelected] = useState(() => typeof window === "undefined" ? null : workspaceRoute(window.location.pathname));
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]), [info, setInfo] = useState<WorkbenchInfo | null>(null);
  const [title, setTitle] = useState(""), [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const creatingRef = useRef(false);
  useEffect(() => { const pop = () => setSelected(workspaceRoute(window.location.pathname)); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    void Promise.all([api.info(controller.signal), api.list(controller.signal)]).then(([configuration, list]) => { if (!controller.signal.aborted) { setInfo(configuration); setWorkspaces(list.items); } }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  function navigate(id: string) { window.history.pushState(null, "", workspaceUrl(id)); setSelected(id); }
  function update(workspace: Workspace) { setWorkspaces(previous => previous.map(item => item.id === workspace.id ? workspace : item)); }
  async function create() {
    if (creatingRef.current || loading) return; creatingRef.current = true; setCreating(true); setError(null);
    try { const workspace = await api.create(title, url); setWorkspaces(previous => [...previous, workspace]); setTitle(""); setUrl(""); navigate(workspace.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { creatingRef.current = false; setCreating(false); }
  }
  const current = workspaces.find(workspace => workspace.id === selected);
  return <main><header className="top"><div><h1>SwarmHive</h1><p>官方 Codex SDK · E2B 工作台</p></div><small>{info ? `${info.engine} · ${info.version} · ${info.model ?? "默认模型"}` : "正在读取配置…"}</small></header><p className="banner">{info?.note ?? "使用官方 Codex SDK 的最小客户端，不是完整 Codex UI。无额外研发流程、角色或记忆提示词注入。"}</p>{info && !info.configured && <p className="error">待配置：{info.missing.join("、")}</p>}{error && <p role="alert" className="error">{error} <button disabled={loading || creating} onClick={() => setRefresh(value => value + 1)}>重新读取</button></p>}
    <div className="layout"><aside><h2>工作区</h2><form onSubmit={event => { event.preventDefault(); void create(); }}><label>名称<input value={title} onChange={event => setTitle(event.target.value)} required disabled={creating} /></label><label>需求来源 URL（可选）<input value={url} onChange={event => setUrl(event.target.value)} type="url" disabled={creating} /></label><button disabled={creating || loading || !title.trim()}>{creating ? "登记中…" : "登记工作区"}</button><p className="hint">只登记，不自动创建沙箱或启动任务。</p></form><nav aria-label="工作区列表">{workspaces.map(workspace => <a href={workspaceUrl(workspace.id)} key={workspace.id} aria-current={workspace.id === selected ? "page" : undefined} onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(workspace.id); }}><strong>{workspace.title}</strong><small>{workspace.sandboxId ? "已有沙箱" : "尚未创建环境"}</small></a>)}</nav>{loading && <p role="status">读取中…</p>}<button disabled={loading || creating} onClick={() => setRefresh(value => value + 1)}>刷新工作区</button></aside>{current ? <WorkspacePane key={current.id} initial={current} onUpdate={update} /> : <section className="empty">{selected && !loading ? "没有找到该工作区。" : "登记或选择一个工作区，然后显式打开环境。"}</section>}</div>
  </main>;
}
