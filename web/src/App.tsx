import {
  createContext,
  memo,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import type {
  AgentInstanceStatus,
  AgentConversationResponse,
  AgentInstanceDetail,
  AgentSpecOverviewResponse,
  AgentSpecSummary,
  InboxEventsResponse,
  GlobalRunsResponse,
  GlobalInboxEventsResponse,
  ProjectSummary,
  ProjectWorkbench,
  ProjectRunsResponse,
  RunEventDto,
  RunStatus,
} from "../../src/contracts/workbench";
import type {
  AgentSeatResult,
  FeishuWorkItemPreview,
} from "../../src/contracts/projects";
import {
  createAgentSeat,
  cancelAgentRun,
  loadInboxEvents,
  loadAllRuns,
  loadAllInboxEvents,
  loadAgentSpecs,
  loadAgentSeat,
  loadAgentConversation,
  loadAgentSpecOverview,
  loadProjectRuns,
  loadProjects,
  loadProjectWorkbench,
  previewFeishuWorkItem,
  resumeAgentRun,
  startAgentRun,
} from "./api";
import {
  createWorkbenchUrl,
  readWorkbenchRoute,
  type MainSection,
  type WorkbenchRoute,
} from "./navigation";

const WorkbenchContext = createContext<ProjectWorkbench | null>(null);

const runStatusLabels: Record<RunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_user: "等待人工",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const instanceStatusLabels: Record<AgentInstanceStatus, string> = {
  active: "已激活",
  disabled: "已停用",
};

const taskStatusLabels = {
  pending: "待处理",
  assigned: "已分配",
  running: "进行中",
  blocked: "阻塞",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
} as const;

interface PendingAgentQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}

function pendingAgentQuestions(
  conversation: AgentConversationResponse | null,
): PendingAgentQuestion[] {
  for (const message of [...(conversation?.messages ?? [])].reverse()) {
    const call = [...message.toolCalls].reverse()
      .find((candidate) => candidate.name === "request_user_input");
    if (!call || !call.args || typeof call.args !== "object") continue;
    const questions = (call.args as { questions?: unknown }).questions;
    if (!Array.isArray(questions)) continue;
    return questions.filter((question): question is PendingAgentQuestion => {
      if (!question || typeof question !== "object") return false;
      const value = question as Partial<PendingAgentQuestion>;
      return typeof value.id === "string" && typeof value.header === "string" &&
        typeof value.question === "string" && Array.isArray(value.options);
    });
  }
  return [];
}

function useWorkbench(): ProjectWorkbench {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("Workbench data is unavailable");
  return value;
}

function formatDate(value: string | null, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...options,
  }).format(new Date(value));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining ? `${minutes} 分 ${remaining} 秒` : `${minutes} 分钟`;
}

function eventState(event: RunEventDto): "completed" | "running" | "pending" {
  const state = event.data.state;
  if (state === "completed" || state === "running" || state === "pending") return state;
  return "completed";
}

function Glyph({ children }: { children: ReactNode }) {
  return <span className="glyph" aria-hidden="true">{children}</span>;
}

function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {runStatusLabels[status]}
    </span>
  );
}

function Sidebar({ active, onChange }: { active: MainSection; onChange: (section: MainSection) => void }) {
  const data = useContext(WorkbenchContext);
  const [projectCount, setProjectCount] = useState(data ? 1 : 0);
  useEffect(() => {
    let mounted = true;
    loadProjects().then((response) => {
      if (mounted) setProjectCount(response.items.length);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);
  const statistics = data?.statistics ?? { activeRuns: 0, totalRuns: 0 };
  const navigation = [
    { key: "import" as const, icon: "+", label: "导入项目" },
    { key: "projects" as const, icon: "▦", label: "项目列表", badge: String(projectCount) },
    { key: "runs" as const, icon: "◫", label: "运行记录", badge: String(statistics.totalRuns) },
    { key: "events" as const, icon: "↯", label: "事件中心" },
    { key: "specs" as const, icon: "◇", label: "Agent Specs" },
  ];
  return (
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">SH</div><div><strong>SwarmHive</strong><span>AI Agent 蜂群工作台</span></div></div>
      <div className="nav-label">工作台</div>
      <nav aria-label="主导航">
        {navigation.map((item) => (
          <button className={`nav-item ${active === item.key ? "active" : ""}`} key={item.label} type="button" aria-label={item.label} onClick={() => onChange(item.key)} aria-current={active === item.key ? "page" : undefined}>
            <Glyph>{item.icon}</Glyph><span>{item.label}</span>
            {item.badge && <span className="nav-badge">{item.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-spacer" />
      <div className="system-state">
        <div className="system-state-row"><span className="health-dot" /><span>服务运行正常</span></div>
        <span className="system-detail">{statistics.activeRuns} 个 Run 正在运行</span>
      </div>
      <div className="profile"><div className="avatar">高</div><div><strong>个人工作区</strong><span>Developer</span></div></div>
    </aside>
  );
}

function displayFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") {
    const cleaned = value.replace(/<!--[\s\S]*?-->/g, "").trim();
    return /^[a-f0-9]{20,}$/i.test(cleaned) ? "已设置" : cleaned || "—";
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(displayFieldValue).filter((item) => item !== "—").join("、") || "—";
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return displayFieldValue(item.label ?? item.name ?? item.text ?? item.value);
  }
  return String(value);
}

function FeishuProjectImportView({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<FeishuWorkItemPreview | null>(null);
  const [specs, setSpecs] = useState<AgentSpecSummary[]>([]);
  const [specKey, setSpecKey] = useState("project-coordinator");
  const [responsibility, setResponsibility] = useState("");
  const [isCoordinator, setIsCoordinator] = useState(true);
  const [seats, setSeats] = useState<AgentSeatResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadAgentSpecs().then((result) => {
      if (!active) return;
      setSpecs(result.items);
      if (result.items[0] && !result.items.some((spec) => spec.id === specKey)) {
        setSpecKey(result.items[0].id);
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, []);

  async function previewProject(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setPreview(null);
    setSeats([]);
    try {
      const result = await previewFeishuWorkItem(url.trim());
      setPreview(result);
      setSeats(result.seats);
      setResponsibility("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  async function assignAgent(event: FormEvent) {
    event.preventDefault();
    if (!preview) return;
    setAssigning(true);
    setError(null);
    try {
      const seat = await createAgentSeat({
        url: preview.sourceUrl,
        specKey,
        responsibility: responsibility.trim(),
        isCoordinator,
      });
      setSeats((items) => [...items, seat]);
      setResponsibility("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAssigning(false);
    }
  }

  const highlightedFields = preview?.fields.filter((field) =>
    ["描述", "优先级", "预计上车版本", "标签"].includes(field.name),
  ) ?? [];

  return <>
    <GlobalHeader eyebrow="PROJECT IMPORT" title="导入飞书项目" description="读取飞书工作项并分配 Agent Seat；分配完成即视为导入" />
    <section className="panel project-opener">
      <form className="url-form" onSubmit={previewProject}>
        <label htmlFor="feishu-url">飞书项目工作项地址</label>
        <div><input id="feishu-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://project.feishu.cn/space/story/detail/123456" /><button type="submit" disabled={loading}>{loading ? "读取中…" : "打开项目"}</button></div>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}
    </section>
    {preview && <div className="live-project-grid">
      <section className="panel live-project-card">
        <div className="live-source"><span className="health-dot" />飞书实时数据 <a href={preview.sourceUrl} target="_blank" rel="noreferrer">在飞书中打开 ↗</a></div>
        <div className="project-title"><div className="project-symbol">需</div><div><h2>{preview.title}</h2><p>{preview.project.name} · {preview.workItemType.name} #{preview.workItemId}</p></div><span className="project-status"><span />{preview.status?.name ?? "未知状态"}</span></div>
        <div className="node-list"><div className="eyebrow">CURRENT NODE</div>{preview.currentNodes.map((node) => <div className="node-item" key={node.id}><strong>{node.name}</strong><span>{node.owners.map((owner) => owner.name).join("、") || "未设置负责人"}</span></div>)}</div>
        <dl className="live-fields">{highlightedFields.map((field) => <DefinitionRow key={field.key} label={field.name}>{displayFieldValue(field.value)}</DefinitionRow>)}</dl>
        <div className="role-list"><div className="eyebrow">ROLES</div><div>{preview.roles.map((item) => <span key={item.key}><strong>{item.name}</strong>{item.members.map((member) => member.name).join("、") || "未分配"}</span>)}</div></div>
      </section>
      <section className="panel assignment-card">
        <div className="records-heading"><div><div className="eyebrow">AGENT ASSIGNMENT</div><h2>配置项目 Agents</h2><p>一个 Coordinator 对外负责；Software Engineer 执行技术调研与研发交付</p></div></div>
        <form className="assignment-form" onSubmit={assignAgent}>
          <label>Agent Spec<select value={specKey} onChange={(event) => { const value = event.target.value; setSpecKey(value); setIsCoordinator(value === "project-coordinator"); }}>{specs.map((spec) => <option value={spec.id} key={spec.id}>{spec.name} · v{spec.version}</option>)}</select></label>
          <label>职责 / 模块（可选）<input value={responsibility} onChange={(event) => setResponsibility(event.target.value)} placeholder="仅在同类 Agent 分工时填写，例如 backend-module-a" /></label>
          <label className="coordinator-toggle"><input type="checkbox" checked={isCoordinator} onChange={(event) => setIsCoordinator(event.target.checked)} /> 设为项目对外 Coordinator</label>
          <button className="primary-button" type="submit" disabled={assigning}>{assigning ? "正在绑定…" : "绑定 Agent"}</button>
        </form>
        <div className="assigned-list">
          {seats.map((seat) => {
            const defaultResponsibility = specs.find((spec) => spec.id === seat.agentInstance.specKey)?.defaultResponsibility;
            return <div className="assigned-agent" key={seat.seatId}><div><strong>{seat.responsibility || defaultResponsibility || "默认职责"}{seat.isCoordinator ? " · Coordinator" : ""}</strong><span>{seat.agentInstance.specKey} · Agent Seat</span><code>{seat.seatId}</code></div><button type="button" onClick={() => onOpenProject(seat.projectId)}>查看项目</button></div>;
          })}
          {seats.length === 0 && <div className="empty-state compact-empty">尚未分配 Agent Seat；分配后完成导入</div>}
        </div>
      </section>
    </div>}
  </>;
}

function Timeline() {
  const { currentRun } = useWorkbench();
  if (!currentRun) return <div className="empty-state">当前没有运行中的任务</div>;
  return (
    <ol className="timeline" aria-label="当前运行进度">
      {currentRun.events.map((event) => {
        const state = eventState(event);
        const command = typeof event.data.command === "string" ? event.data.command : null;
        return (
          <li className={`timeline-item timeline-${state}`} key={event.sequenceNo}>
            <div className="timeline-marker">{state === "completed" ? "✓" : state === "running" ? "" : event.sequenceNo}</div>
            <div className="timeline-body">
              <div className="timeline-title-row"><strong>{event.title}</strong><time>{formatDate(event.createdAt, { hour: "2-digit", minute: "2-digit" })}</time></div>
              {event.detail && <p>{event.detail}</p>}
              {state === "running" && command && (
                <div className="activity-console"><span className="console-prompt">$</span><code>{command}</code><span className="console-cursor" /></div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function CurrentRunCard() {
  const { currentRun } = useWorkbench();
  if (!currentRun) {
    return <section className="panel run-panel"><div className="panel-header"><div className="eyebrow">当前 RUN</div><h2 className="empty-title">暂无运行中的任务</h2></div></section>;
  }
  const progress = currentRun.progress.percent ?? 0;
  return (
    <section className="panel run-panel" aria-labelledby="current-run-title">
      <div className="panel-header run-header">
        <div>
          <div className="eyebrow">当前 RUN · {currentRun.id.slice(0, 12)}</div>
          <h2 id="current-run-title">{currentRun.taskSummary ?? "未命名任务"}</h2>
          <div className="run-meta">
            <span><Glyph>↳</Glyph>{currentRun.trigger ? `${currentRun.trigger.source} · ${currentRun.trigger.eventType}` : "无触发事件"}</span>
            <span><Glyph>◷</Glyph>{formatDate(currentRun.startedAt)}</span>
            <span>已运行 {formatDuration(currentRun.elapsedSeconds)}</span>
          </div>
        </div>
        <StatusBadge status={currentRun.status} />
      </div>
      <div className="progress-block">
        <div className="progress-summary"><span>{currentRun.progress.summary}</span><strong>{progress}%</strong></div>
        <div className="progress-track" aria-label={`运行进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
      </div>
      <Timeline />
    </section>
  );
}

function RecentRuns() {
  const { recentRuns, statistics } = useWorkbench();
  return (
    <section className="panel recent-panel" aria-labelledby="recent-runs-title">
      <div className="panel-header compact-header"><div><div className="eyebrow">执行历史</div><h2 id="recent-runs-title">最近运行</h2></div><span className="muted-count">共 {statistics.totalRuns} 次</span></div>
      <div className="run-list">
        {recentRuns.map((run, index) => (
          <div className="run-row" key={run.id}>
            <span className="run-number">#{String(statistics.totalRuns - index).padStart(3, "0")}</span>
            <div className="run-description"><strong>{run.taskSummary ?? "未命名任务"}</strong><span>{run.trigger?.source ?? "系统"} · {formatDate(run.createdAt)}</span></div>
            <span className="run-duration">{formatDuration(run.durationSeconds)}</span>
            <StatusBadge status={run.status} />
          </div>
        ))}
        {recentRuns.length === 0 && <div className="empty-state compact-empty">暂无运行记录</div>}
      </div>
    </section>
  );
}

function DefinitionRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="definition-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function AgentInstancePanel() {
  const { coordinatorSeat, currentRun, latestInboxEvent: inbox, runtime } = useWorkbench();
  const instance = coordinatorSeat?.agentInstance;
  return (
    <aside className="detail-column" aria-label="Agent Instance 信息">
      <section className="panel instance-panel">
        <div className="instance-heading"><div className="instance-icon">AI</div><div><div className="eyebrow">AGENT INSTANCE</div><h2>研发员工实例</h2></div><span className={currentRun?.status === "running" ? "live-indicator" : "idle-indicator"} /></div>
        {coordinatorSeat && instance ? (
          <>
            <div className="instance-state-card"><div><span>启用状态</span><strong>{instanceStatusLabels[instance.status]}</strong></div></div>
            <dl className="definition-list">
              <DefinitionRow label="Seat ID"><code>{coordinatorSeat.id}</code></DefinitionRow>
              <DefinitionRow label="职责">{coordinatorSeat.responsibility || "—"}</DefinitionRow>
              <DefinitionRow label="Instance ID"><code>{instance.id}</code></DefinitionRow>
              <DefinitionRow label="Agent Spec"><span className="spec-chip">{instance.specKey}</span><span className="version-chip">v{instance.specVersion}</span></DefinitionRow>
              <DefinitionRow label="Workspace"><code className="path-code">{coordinatorSeat.workspaceKey}</code></DefinitionRow>
              <DefinitionRow label="Thread ID"><code className="path-code">{coordinatorSeat.session.threadId}</code></DefinitionRow>
              <DefinitionRow label="最近激活">{formatDate(instance.lastActiveAt)}</DefinitionRow>
            </dl>
          </>
        ) : <div className="empty-state">尚未绑定 Agent Instance</div>}
      </section>
      <section className="panel event-panel">
        {inbox ? (
          <><div className="compact-title"><div className="event-icon">↯</div><div><div className="eyebrow">最近接收事件</div><h3>{inbox.eventType}</h3></div><span className="tiny-success">{inbox.status}</span></div>
          <dl className="event-details"><DefinitionRow label="来源">{inbox.source}</DefinitionRow><DefinitionRow label="Event ID"><code>{inbox.externalEventId}</code></DefinitionRow><DefinitionRow label="接收时间">{formatDate(inbox.receivedAt)}</DefinitionRow></dl></>
        ) : <div className="empty-state compact-empty">暂无接收事件</div>}
      </section>
      <section className="panel runtime-panel">
        <div className="runtime-row"><span className={runtime.status === "online" ? "health-dot" : "runtime-dot-offline"} /><div><strong>开发容器{runtime.status === "online" ? "在线" : runtime.status === "offline" ? "离线" : "状态未知"}</strong><span>{runtime.name}</span></div><span className="latency">{runtime.latencyMs === null ? "—" : `${runtime.latencyMs} ms`}</span></div>
      </section>
    </aside>
  );
}

type TabKey = "overview" | "runs" | "events" | "basic";

function Tabs({ active, onChange }: { active: TabKey; onChange: (tab: TabKey) => void }) {
  const { statistics } = useWorkbench();
  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: "overview", label: "概览" },
    { key: "runs", label: "运行记录", count: statistics.totalRuns },
    { key: "events", label: "接收事件" },
    { key: "basic", label: "基本信息" },
  ];
  return (
    <div className="tabs" role="tablist" aria-label="项目视图">
      {tabs.map((tab) => (
        <button
          className={`tab ${active === tab.key ? "active" : ""}`}
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          aria-controls={`panel-${tab.key}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}{tab.count !== undefined && <em>{tab.count}</em>}
        </button>
      ))}
    </div>
  );
}

function RunsView() {
  const { project } = useWorkbench();
  const [data, setData] = useState<ProjectRunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    loadProjectRuns(project.id).then(
      (result) => { if (active) setData(result); },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { active = false; };
  }, [project.id]);
  return (
    <section className="panel records-view" id="panel-runs" role="tabpanel">
      <div className="records-heading"><div><div className="eyebrow">RUN HISTORY</div><h2>运行记录</h2><p>Project 下的全部 Agent 执行记录</p></div><span className="readonly-note">只读</span></div>
      {error ? <div className="empty-state error-state">{error}</div> : !data ? <div className="empty-state">正在读取运行记录…</div> : (
        <div className="records-table" aria-label="运行记录列表">
          <div className="records-row records-header"><span>任务</span><span>触发方式</span><span>开始时间</span><span>耗时</span><span>状态</span></div>
          {data.items.map((run) => (
            <div className="records-row" key={run.id}>
              <div className="record-primary"><strong>{run.taskSummary ?? "未命名任务"}</strong><code>{run.id}</code></div>
              <span>{run.trigger ? `${run.trigger.source} · ${run.trigger.eventType}` : "系统"}</span>
              <span>{formatDate(run.startedAt ?? run.createdAt)}</span>
              <span>{formatDuration(run.durationSeconds)}</span>
              <StatusBadge status={run.status} />
            </div>
          ))}
          {data.items.length === 0 && <div className="empty-state">暂无运行记录</div>}
        </div>
      )}
    </section>
  );
}

function InboxEventsView() {
  const { project } = useWorkbench();
  const [data, setData] = useState<InboxEventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    loadInboxEvents(project.id).then(
      (result) => { if (active) setData(result); },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { active = false; };
  }, [project.id]);
  return (
    <section className="panel records-view" id="panel-events" role="tabpanel">
      <div className="records-heading"><div><div className="eyebrow">INBOX EVENTS</div><h2>接收事件</h2><p>来自飞书及其他外部系统的项目事件</p></div><span className="readonly-note">只读</span></div>
      {error ? <div className="empty-state error-state">{error}</div> : !data ? <div className="empty-state">正在读取接收事件…</div> : (
        <div className="records-table event-records" aria-label="接收事件列表">
          <div className="records-row records-header"><span>事件类型</span><span>来源</span><span>Event ID</span><span>接收时间</span><span>状态</span></div>
          {data.items.map((event) => (
            <div className="records-row" key={event.id}>
              <div className="record-primary"><strong>{event.eventType}</strong><code>{event.id}</code></div>
              <span>{event.source}</span>
              <code className="event-id-cell">{event.externalEventId}</code>
              <span>{formatDate(event.receivedAt)}</span>
              <span className={`event-status event-status-${event.status}`}><i />{event.status}</span>
            </div>
          ))}
          {data.items.length === 0 && <div className="empty-state">暂无接收事件</div>}
        </div>
      )}
    </section>
  );
}

function BasicInfoView() {
  const { project, coordinatorSeat, runtime } = useWorkbench();
  const instance = coordinatorSeat?.agentInstance;
  return (
    <div className="basic-grid" id="panel-basic" role="tabpanel">
      <section className="panel basic-panel">
        <div className="records-heading"><div><div className="eyebrow">PROJECT</div><h2>项目基本信息</h2></div><span className="readonly-note">只读</span></div>
        <dl className="basic-definition-list">
          <DefinitionRow label="Project ID"><code>{project.id}</code></DefinitionRow>
          <DefinitionRow label="项目名称">{project.name ?? "—"}</DefinitionRow>
          <DefinitionRow label="来源">{project.source}</DefinitionRow>
          <DefinitionRow label="外部项目 ID"><code>{project.externalProjectId}</code></DefinitionRow>
          <DefinitionRow label="负责人">{project.owner ?? "未设置"}</DefinitionRow>
          <DefinitionRow label="状态">{project.status}</DefinitionRow>
          <DefinitionRow label="更新时间">{formatDate(project.updatedAt)}</DefinitionRow>
        </dl>
      </section>
      <section className="panel basic-panel">
        <div className="records-heading"><div><div className="eyebrow">AGENT INSTANCE</div><h2>实例与运行环境</h2></div></div>
        <dl className="basic-definition-list">
          <DefinitionRow label="Seat ID"><code>{coordinatorSeat?.id ?? "—"}</code></DefinitionRow>
          <DefinitionRow label="职责">{coordinatorSeat?.responsibility || "—"}</DefinitionRow>
          <DefinitionRow label="Instance ID"><code>{instance?.id ?? "—"}</code></DefinitionRow>
          <DefinitionRow label="Agent Spec">{instance ? `${instance.specKey} · v${instance.specVersion}` : "—"}</DefinitionRow>
          <DefinitionRow label="Instance 启用状态">{instance ? instanceStatusLabels[instance.status] : "未绑定"}</DefinitionRow>
          <DefinitionRow label="Agent Home"><code>{instance?.homeKey ?? "—"}</code></DefinitionRow>
          <DefinitionRow label="Workspace"><code>{coordinatorSeat?.workspaceKey ?? "—"}</code></DefinitionRow>
          <DefinitionRow label="Thread ID"><code>{coordinatorSeat?.session.threadId ?? "—"}</code></DefinitionRow>
          <DefinitionRow label="开发容器">{runtime.name}</DefinitionRow>
          <DefinitionRow label="容器状态">{runtime.status}</DefinitionRow>
        </dl>
      </section>
    </div>
  );
}

function GlobalHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <section className="global-header"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></section>;
}

function GlobalRunsView() {
  const [data, setData] = useState<GlobalRunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    loadAllRuns().then(
      (result) => { if (active) setData(result); },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { active = false; };
  }, []);
  return <><GlobalHeader eyebrow="RUN CENTER" title="运行记录" description="查看所有 Project 的 Agent 执行记录" /><section className="panel records-view global-records"><div className="records-table"><div className="records-row records-header"><span>任务</span><span>所属项目</span><span>开始时间</span><span>耗时</span><span>状态</span></div>{error ? <div className="empty-state error-state">{error}</div> : !data ? <div className="empty-state">正在读取运行记录…</div> : data.items.map((run) => <div className="records-row" key={run.id}><div className="record-primary"><strong>{run.taskSummary ?? "未命名任务"}</strong><code>{run.id}</code></div><span>{run.project.name ?? run.project.externalProjectId}</span><span>{formatDate(run.startedAt ?? run.createdAt)}</span><span>{formatDuration(run.durationSeconds)}</span><StatusBadge status={run.status} /></div>)}</div></section></>;
}

function GlobalEventsView() {
  const [data, setData] = useState<GlobalInboxEventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    loadAllInboxEvents().then(
      (result) => { if (active) setData(result); },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { active = false; };
  }, []);
  return <><GlobalHeader eyebrow="EVENT CENTER" title="事件中心" description="查看所有外部系统接收和处理的 Inbox Event" /><section className="panel records-view global-records"><div className="records-table"><div className="records-row records-header"><span>事件类型</span><span>所属项目</span><span>来源</span><span>接收时间</span><span>状态</span></div>{error ? <div className="empty-state error-state">{error}</div> : !data ? <div className="empty-state">正在读取事件…</div> : data.items.map((event) => <div className="records-row" key={event.id}><div className="record-primary"><strong>{event.eventType}</strong><code>{event.externalEventId}</code></div><span>{event.project?.name ?? "未关联项目"}</span><span>{event.source}</span><span>{formatDate(event.receivedAt)}</span><span className={`event-status event-status-${event.status}`}><i />{event.status}</span></div>)}</div></section></>;
}

function AgentSpecsView() {
  const [data, setData] = useState<AgentSpecOverviewResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSpecId, setSelectedSpecId] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "prompt" | "memory" | "work">("overview");
  useEffect(() => {
    let active = true;
    loadAgentSpecs().then((result) =>
      Promise.all(result.items.map((spec) => loadAgentSpecOverview(spec.id))),
    ).then(
      (result) => {
        if (!active) return;
        setData(result);
        setSelectedSpecId((current) => current ?? result[0]?.spec.id ?? null);
      },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { active = false; };
  }, []);
  const selected = data?.find((item) => item.spec.id === selectedSpecId) ?? data?.[0] ?? null;
  return <>
    <GlobalHeader eyebrow="AGENT CATALOG" title="Agent Specs" description="查看 Agent 的完整定义、长期记忆、运行实例与当前工作" />
    {error ? <section className="panel empty-state error-state">{error}</section> : !data ? <section className="panel empty-state">正在读取 Agent Specs…</section> : (
      <div className="spec-workbench">
        <aside className="panel spec-directory" aria-label="Agent Spec 列表">
          <div className="spec-directory-heading"><span>SPEC LIBRARY</span><strong>{data.length} 个定义</strong></div>
          {data.map(({ spec, statistics }) => (
            <button
              className={`spec-selector ${selected?.spec.id === spec.id ? "is-selected" : ""}`}
              key={spec.id}
              onClick={() => { setSelectedSpecId(spec.id); setTab("overview"); }}
              type="button"
            >
              <span className="instance-icon">AI</span>
              <span className="spec-selector-copy"><strong>{spec.name}</strong><code>{spec.id}</code></span>
              <span className="spec-selector-meta"><em>v{spec.version}</em><small>{statistics.instances} Ins</small></span>
            </button>
          ))}
        </aside>
        {selected && <section className="panel spec-detail">
          <header className="spec-detail-hero">
            <div className="spec-detail-title"><div className="instance-icon large">AI</div><div><span className="eyebrow">AGENT SPEC</span><h2>{selected.spec.name}</h2><code>{selected.spec.id} · version {selected.spec.version}</code></div></div>
            <div className="spec-metrics" aria-label={`${selected.spec.name} 使用情况`}>
              <div><strong>{selected.statistics.instances}</strong><span>Agent Instances</span></div>
              <div><strong>{selected.statistics.activeSeats}</strong><span>活跃 Seats</span></div>
              <div><strong>{selected.statistics.runningSeats}</strong><span>运行中 Seats</span></div>
            </div>
          </header>
          <nav className="spec-detail-tabs" aria-label="Spec 详情导航">
            {([{"value":"overview","label":"概览"},{"value":"prompt","label":"系统提示词"},{"value":"memory","label":"Memory"},{"value":"work","label":"Instances 与工作"}] as const).map((item) => <button className={tab === item.value ? "is-active" : ""} key={item.value} onClick={() => setTab(item.value)} type="button">{item.label}{item.value === "work" && <span>{selected.instances.length}</span>}</button>)}
          </nav>
          <div className="spec-detail-body">
            {tab === "overview" && <div className="spec-overview-grid">
              <section><div className="section-heading"><span className="eyebrow">RUNTIME</span><h3>运行定义</h3></div><dl className="basic-definition-list spec-definition-list">
                <DefinitionRow label="Sandbox Image"><code>{selected.spec.sandbox.image}</code></DefinitionRow>
                <DefinitionRow label="Dockerfile"><code>{selected.spec.sandbox.dockerfile}</code></DefinitionRow>
                <DefinitionRow label="Environment"><code>{selected.spec.environmentExample}</code></DefinitionRow>
                <DefinitionRow label="Memory 文件"><code>{selected.spec.memory}</code></DefinitionRow>
                <DefinitionRow label="默认职责">{selected.spec.defaultResponsibility}</DefinitionRow>
              </dl></section>
              <section><div className="section-heading"><span className="eyebrow">INSTANCES</span><h3>当前实例</h3></div><div className="instance-summary-list">
                {selected.instances.map(({ agentInstance, seats, tasks }) => <div className="instance-summary" key={agentInstance.id}><span className={`event-status event-status-${agentInstance.status}`}><i />{instanceStatusLabels[agentInstance.status]}</span><div><strong>{agentInstance.instanceKey}</strong><code>{agentInstance.id}</code></div><span>{seats.length} 项目 · {tasks.filter((task) => !["completed", "cancelled"].includes(task.status)).length} 项工作</span></div>)}
                {selected.instances.length === 0 && <div className="empty-state compact-empty">这个 Spec 尚未实例化</div>}
              </div></section>
            </div>}
            {tab === "prompt" && <SpecSource title="系统提示词" filename="prompt.txt" content={selected.definition.prompt} />}
            {tab === "memory" && <SpecSource title="Spec Memory" filename={selected.spec.memory} content={selected.definition.memory} />}
            {tab === "work" && <AgentInstanceWork instances={selected.instances} />}
          </div>
        </section>}
      </div>
    )}
  </>;
}

function SpecSource({ title, filename, content }: { title: string; filename: string; content: string }) {
  return <section className="spec-source-panel"><div className="section-heading source-heading"><div><span className="eyebrow">SPEC CONTENT</span><h3>{title}</h3></div><code>{filename}</code></div><pre className="spec-source">{content || "（文件为空）"}</pre></section>;
}

function AgentInstanceWork({ instances }: { instances: AgentInstanceDetail[] }) {
  if (instances.length === 0) return <div className="empty-state">这个 Spec 尚未实例化，也没有关联工作</div>;
  return <div className="instance-work-list">{instances.map(({ agentInstance, seats, tasks, recentRuns }) => <article className="instance-work-card" key={agentInstance.id}>
    <header><div><span className="eyebrow">AGENT INSTANCE</span><h3>{agentInstance.instanceKey}</h3><code>{agentInstance.id}</code></div><span className={`event-status event-status-${agentInstance.status}`}><i />{instanceStatusLabels[agentInstance.status]}</span></header>
    <div className="instance-facts"><span><small>HOME KEY</small><code>{agentInstance.homeKey}</code></span><span><small>最近活跃</small><strong>{formatDate(agentInstance.lastActiveAt)}</strong></span><span><small>创建时间</small><strong>{formatDate(agentInstance.createdAt)}</strong></span></div>
    <div className="instance-work-columns">
      <section><div className="work-column-heading"><strong>关联项目与 Seat</strong><span>{seats.length}</span></div>{seats.map((seat) => <a className="work-item" href={`/projects/${encodeURIComponent(seat.project.id)}/agent-seats/${encodeURIComponent(seat.id)}`} key={seat.id}><div><strong>{seat.project.externalProjectId}</strong><small>{seat.responsibility || "默认职责"}{seat.isCoordinator ? " · Coordinator" : ""}</small></div>{seat.currentRun ? <StatusBadge status={seat.currentRun.status} /> : <span className="muted">{seat.session.status}</span>}</a>)}{seats.length === 0 && <p className="muted-empty">暂无活跃项目席位</p>}</section>
      <section><div className="work-column-heading"><strong>分配的工作</strong><span>{tasks.length}</span></div>{tasks.map((task) => <div className="work-item" key={task.id}><div><strong>{task.title}</strong><small>{task.project.name ?? task.project.externalProjectId} · {formatDate(task.updatedAt)}</small>{task.blockedReason && <em>{task.blockedReason}</em>}</div><span className={`event-status event-status-${task.status}`}><i />{taskStatusLabels[task.status]}</span></div>)}{tasks.length === 0 && <p className="muted-empty">暂无分配任务</p>}</section>
    </div>
    <footer><span>最近运行 {recentRuns.length} 次</span>{recentRuns[0] && <><StatusBadge status={recentRuns[0].status} /><strong>{recentRuns[0].taskSummary ?? "未命名任务"}</strong><time>{formatDate(recentRuns[0].createdAt)}</time></>}</footer>
  </article>)}</div>;
}

function ProjectListView({
  selectedProjectId,
  onSelectProject,
  onOpenSeat,
}: {
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onOpenSeat: (agentSeatId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [previews, setPreviews] = useState<Record<string, FeishuWorkItemPreview>>({});
  const [starting, setStarting] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadProjects().then(async (response) => {
      if (!active) return;
      const importedProjects = response.items.filter(
        (project) => project.source === "feishu_project" && project.externalUrl,
      );
      setProjects(importedProjects);
      const loaded = await Promise.all(importedProjects.map(async (project) => {
        try {
          return [project.id, await previewFeishuWorkItem(project.externalUrl!)] as const;
        } catch {
          return null;
        }
      }));
      if (active) {
        setPreviews(Object.fromEntries(loaded.filter((item): item is readonly [string, FeishuWorkItemPreview] => item !== null)));
        setLoading(false);
      }
    }).catch((reason: unknown) => {
      if (active) {
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => { active = false; };
  }, []);

  async function start(seat: AgentSeatResult) {
    setStarting(seat.seatId);
    setError(null);
    try {
      await startAgentRun(seat.seatId);
      onOpenSeat(seat.seatId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarting(null);
    }
  }

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selected = selectedProjectId ? previews[selectedProjectId] : undefined;
  if (selectedProjectId && selectedProject && !selected && loading) {
    return <div className="empty-state">正在读取项目详情…</div>;
  }
  if (selectedProjectId && selected) {
    const highlightedFields = selected.fields.filter((field) => ["描述", "优先级", "预计上车版本", "标签"].includes(field.name));
    return <>
      <button className="back-button" type="button" onClick={() => onSelectProject(null)}>← 返回项目列表</button>
      <GlobalHeader eyebrow="PROJECT DETAIL" title={selected.title} description={`${selected.project.name} · ${selected.workItemType.name} #${selected.workItemId}`} />
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="live-project-grid project-detail-grid">
        <section className="panel live-project-card">
          <div className="live-source"><span className="health-dot" />飞书实时数据 <a href={selected.sourceUrl} target="_blank" rel="noreferrer">在飞书中打开 ↗</a></div>
          <div className="project-title"><div className="project-symbol">需</div><div><h2>{selected.title}</h2><p>{selected.project.name} · #{selected.workItemId}</p></div><span className="project-status"><span />{selected.status?.name ?? "未知状态"}</span></div>
          <div className="node-list"><div className="eyebrow">CURRENT NODE</div>{selected.currentNodes.map((node) => <div className="node-item" key={node.id}><strong>{node.name}</strong><span>{node.owners.map((owner) => owner.name).join("、") || "未设置负责人"}</span></div>)}</div>
          <dl className="live-fields">{highlightedFields.map((field) => <DefinitionRow key={field.key} label={field.name}>{displayFieldValue(field.value)}</DefinitionRow>)}</dl>
        </section>
        <section className="panel assignment-card">
          <div className="records-heading"><div><div className="eyebrow">AGENT SEATS</div><h2>项目 Agents</h2><p>查看席位职责与运行状态；空闲席位可直接启动</p></div></div>
          <div className="assigned-list project-agent-list">
            {selected.seats.map((seat) => {
              const canStart = seat.agentInstance.status === "active" && !seat.currentRun;
              const state = seat.currentRun
                ? runStatusLabels[seat.currentRun.status]
                : instanceStatusLabels[seat.agentInstance.status];
              return <div className="assigned-agent" key={seat.seatId}><div><strong>{seat.responsibility || "默认职责"}</strong><span>{seat.agentInstance.specKey} · {state}</span><code>{seat.seatId}</code></div><div className="assigned-agent-actions"><button className="secondary-button" type="button" onClick={() => onOpenSeat(seat.seatId)}>查看 Agent Seat</button>{canStart && <button type="button" onClick={() => void start(seat)} disabled={starting === seat.seatId}>{starting === seat.seatId ? "正在唤醒…" : "启动 Agent"}</button>}</div></div>;
            })}
            {selected.seats.length === 0 && <div className="empty-state">该项目尚未分配 Agent Seat</div>}
          </div>
        </section>
      </div>
    </>;
  }

  return <>
    <GlobalHeader eyebrow="PROJECTS" title="项目列表" description="所有已经分配 Agent Seat、完成导入的飞书工作项" />
    {error && <div className="form-error" role="alert">{error}</div>}
    <section className="panel project-directory">
      <div className="project-directory-heading"><div><h2>已导入项目</h2><p>点击项目进入详情并查看关联 Agent Seat</p></div><span>{projects.length} 个</span></div>
      <div className="project-directory-list">
        {projects.map((project) => {
          const preview = previews[project.id];
          const title = preview?.title ?? project.name ?? `飞书工作项 #${project.externalProjectId}`;
          return <button type="button" className="project-directory-item" key={project.id} onClick={() => onSelectProject(project.id)}><span className="project-directory-symbol">项</span><span className="project-directory-main"><strong>{title}</strong><small>{preview?.status?.name ?? "飞书项目"} · {project.externalProjectId}</small></span><span>{preview?.seats.length ?? (project.coordinatorSeat ? 1 : 0)} 个 Seat</span></button>;
        })}
        {loading && <div className="empty-state">正在读取项目…</div>}
        {!loading && projects.length === 0 && <div className="empty-state">尚未导入项目，请先从“导入项目”分配 Agent Seat</div>}
      </div>
    </section>
  </>;
}

const ConversationPanel = memo(function ConversationPanel({
  conversation,
  runStatus,
}: {
  conversation: AgentConversationResponse | null;
  runStatus: RunStatus | null;
}) {
  return <section className="panel conversation-panel">
    <div className="panel-header run-header"><div><div className="eyebrow">CONVERSATION</div><h2>执行对话</h2></div>{runStatus && <StatusBadge status={runStatus} />}</div>
    <div className="conversation-list">
      {conversation?.messages.map((message) => (
        <article className={`conversation-message conversation-${message.role}`} key={message.id}>
          <div className="conversation-role">{message.role === "human" ? "用户" : message.role === "ai" ? "Agent" : message.role === "tool" ? `工具 · ${message.name ?? "unknown"}` : "System"}</div>
          {message.content && (message.role === "tool"
            ? <details className="tool-result"><summary>查看工具输出</summary><pre>{message.content}</pre></details>
            : <pre>{message.content}</pre>)}
          {message.toolCalls.map((call) => <details className="tool-call" key={call.id}><summary>调用工具 · {call.name}</summary><pre>{JSON.stringify(call.args, null, 2)}</pre></details>)}
        </article>
      ))}
      {conversation && conversation.messages.length === 0 && <div className="empty-state">Agent 尚未产生对话</div>}
      {!conversation && <div className="empty-state">正在读取执行对话…</div>}
    </div>
  </section>;
});

function AgentSeatDetailView({ agentSeatId, onBack }: { agentSeatId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<AgentInstanceDetail | null>(null);
  const [conversation, setConversation] = useState<AgentConversationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<"start" | "cancel" | "resume" | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      let shouldPoll = true;
      try {
        const instance = await loadAgentSeat(agentSeatId);
        const sessionId = instance.seats.find((seat) => seat.id === agentSeatId)?.session.id;
        const messages = sessionId ? await loadAgentConversation(sessionId) : null;
        if (active) {
          setDetail(instance);
          setConversation((current) => !messages || current?.checkpointId === messages.checkpointId
            ? current
            : messages);
          setError(null);
          shouldPoll = instance.seats.some((seat) => Boolean(seat.currentRun &&
            ["queued", "running", "waiting_user"].includes(seat.currentRun.status)));
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
      if (active && shouldPoll) timer = window.setTimeout(refresh, 3000);
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agentSeatId, refreshVersion]);
  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!detail) return <div className="empty-state">正在读取 Agent Instance…</div>;
  const instance = detail.agentInstance;
  const seat = detail.seats.find((item) => item.id === agentSeatId);
  const activeRun = seat?.currentRun && ["queued", "running", "waiting_user"].includes(seat.currentRun.status)
    ? seat.currentRun
    : null;
  const canStart = Boolean(seat) && instance.status === "active" && !activeRun;
  const durableQuestions: PendingAgentQuestion[] = [];
  const pendingQuestions = activeRun?.status === "waiting_user"
    ? (durableQuestions.length > 0 ? durableQuestions : pendingAgentQuestions(conversation))
    : [];
  async function runAction(action: "start" | "cancel") {
    setActing(action);
    setError(null);
    try {
      if (action === "cancel" && activeRun) {
        await cancelAgentRun(activeRun.id);
      } else if (action === "start" && seat) {
        setConversation(null);
        await startAgentRun(seat.id);
      }
      setRefreshVersion((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActing(null);
    }
  }
  async function submitAnswers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeRun || pendingQuestions.length === 0) return;
    const responses = pendingQuestions.map((question) => ({
      question,
      answer: answers[question.id]?.trim() ?? "",
    }));
    if (responses.some((response) => !response.answer)) {
      setError("请回答全部确认项");
      return;
    }
    setActing("resume");
    setError(null);
    try {
      await resumeAgentRun(activeRun.id, {
        message: responses
          .map(({ question, answer }) => `[${question.header}] ${question.question}\n用户回复：${answer}`)
          .join("\n\n"),
      });
      setAnswers({});
      setRefreshVersion((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActing(null);
    }
  }
  return <>
    <button className="back-button" type="button" onClick={onBack}>← 返回项目详情</button>
    <GlobalHeader eyebrow="AGENT SEAT" title={seat?.responsibility || instance.specKey} description={`${instance.specKey}:${instance.instanceKey} · ${agentSeatId}`} />
    <div className="agent-detail-grid">
      <section className="panel instance-panel">
        <div className="instance-heading"><div className="instance-icon">AI</div><div><div className="eyebrow">AGENT INSTANCE</div><h2>{instance.specKey}</h2></div><span className={activeRun?.status === "running" ? "live-indicator" : "idle-indicator"} /></div>
        <div className="instance-state-card"><div><span>启用状态</span><strong>{instanceStatusLabels[instance.status]}</strong></div></div>
        <div className="instance-actions">
          {activeRun && <button className="danger-button" type="button" disabled={acting !== null} onClick={() => void runAction("cancel")}>{acting === "cancel" ? "正在结束…" : "结束 Agent"}</button>}
          {canStart && <button className="primary-button" type="button" disabled={acting !== null} onClick={() => void runAction("start")}>{acting === "start" ? "正在启动…" : "启动 Agent"}</button>}
        </div>
        {activeRun?.status === "waiting_user" && pendingQuestions.length > 0 && <form className="agent-approval-form" onSubmit={(event) => void submitAnswers(event)}>
          <div className="eyebrow">HUMAN GATE</div>
          {pendingQuestions.map((question) => <label key={question.id}><strong>{question.header}</strong><span>{question.question}</span><input list={`agent-answer-${question.id}`} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="选择建议项或输入反馈" disabled={acting !== null} /><datalist id={`agent-answer-${question.id}`}>{question.options.map((option) => <option value={option.label} key={option.label}>{option.description}</option>)}</datalist></label>)}
          <button className="primary-button" type="submit" disabled={acting !== null}>{acting === "resume" ? "正在继续…" : "提交并继续"}</button>
        </form>}
        <dl className="definition-list"><DefinitionRow label="Seat ID"><code>{seat?.id ?? "—"}</code></DefinitionRow><DefinitionRow label="职责">{seat?.responsibility || "—"}</DefinitionRow><DefinitionRow label="Workspace"><code>{seat?.workspaceKey ?? "—"}</code></DefinitionRow><DefinitionRow label="Instance ID"><code>{instance.id}</code></DefinitionRow><DefinitionRow label="Agent Spec">{instance.specKey} · v{instance.specVersion}</DefinitionRow><DefinitionRow label="Instance Key"><code>{instance.instanceKey}</code></DefinitionRow><DefinitionRow label="Agent Home"><code>{instance.homeKey}</code></DefinitionRow><DefinitionRow label="最近活跃">{formatDate(instance.lastActiveAt)}</DefinitionRow></dl>
      </section>
      <ConversationPanel conversation={conversation} runStatus={seat?.currentRun?.status ?? null} />
    </div>
    <section className="panel recent-panel"><div className="panel-header compact-header"><div><div className="eyebrow">AGENT SEATS</div><h2>项目席位</h2></div><span className="muted-count">{detail.seats.length} 个</span></div><div className="run-list">{detail.seats.map((item) => <div className="run-row" key={item.id}><code>{item.session.status}</code><div className="run-description"><strong>{item.responsibility || "默认职责"} · {item.project.externalProjectId}</strong><span>{item.session.threadId}</span></div></div>)}</div></section>
    <section className="panel recent-panel agent-run-history"><div className="panel-header compact-header"><div><div className="eyebrow">RUN HISTORY</div><h2>运行记录</h2></div><span className="muted-count">{detail.recentRuns.length} 次</span></div><div className="run-list">{detail.recentRuns.map((run) => <div className="run-row" key={run.id}><code>{run.id.slice(0, 8)}</code><div className="run-description"><strong>{run.taskSummary ?? "未命名任务"}</strong><span>{formatDate(run.createdAt)}</span></div><span className="run-duration">{formatDuration(run.durationSeconds)}</span><StatusBadge status={run.status} /></div>)}{detail.recentRuns.length === 0 && <div className="empty-state">尚无运行记录</div>}</div></section>
  </>;
}

function WorkbenchPage({ data }: { data: ProjectWorkbench | null }) {
  const [route, setRoute] = useState<WorkbenchRoute>(() =>
    readWorkbenchRoute(new URL(window.location.href)),
  );

  useEffect(() => {
    const replaceUrl = createWorkbenchUrl(new URL(window.location.href), route);
    window.history.replaceState(null, "", replaceUrl);
    const handlePopState = () => {
      setRoute(readWorkbenchRoute(new URL(window.location.href)));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function navigate(nextRoute: WorkbenchRoute) {
    const url = createWorkbenchUrl(new URL(window.location.href), nextRoute);
    window.history.pushState(null, "", url);
    setRoute(nextRoute);
  }

  const { section: activeSection, projectId: selectedProjectId, agentSeatId: selectedAgentSeatId } = route;
  function openProject(projectId: string) {
    navigate({ section: "projects", projectId, agentSeatId: null });
  }
  function openSeat(agentSeatId: string) {
    navigate({ section: "seat", projectId: selectedProjectId, agentSeatId });
  }
  function changeSection(section: MainSection) {
    navigate({ section, projectId: null, agentSeatId: null });
  }
  const sectionTitle = activeSection === "import" ? "导入项目" : activeSection === "projects" ? "项目列表" : activeSection === "seat" ? "Agent Seat" : activeSection === "runs" ? "运行记录" : activeSection === "events" ? "事件中心" : "Agent Specs";
  return <div className="app-shell">
    <Sidebar active={activeSection === "seat" ? "projects" : activeSection} onChange={changeSection} />
    <main className="workspace">
      <header className="topbar"><div className="breadcrumbs"><span>工作台</span><span className="breadcrumb-separator">/</span><strong>{sectionTitle}</strong></div><div className="topbar-meta">{activeSection !== "import" && <span className="readonly-badge"><Glyph>◉</Glyph>{activeSection === "projects" || activeSection === "seat" ? "实时状态" : "只读视图"}</span>}</div></header>
      <div className="page-content">
        {activeSection === "import" && <FeishuProjectImportView onOpenProject={openProject} />}
        {activeSection === "projects" && <ProjectListView selectedProjectId={selectedProjectId} onSelectProject={(projectId) => navigate({ section: "projects", projectId, agentSeatId: null })} onOpenSeat={openSeat} />}
        {activeSection === "seat" && selectedAgentSeatId && <AgentSeatDetailView agentSeatId={selectedAgentSeatId} onBack={() => navigate({ section: "projects", projectId: selectedProjectId, agentSeatId: null })} />}
        {activeSection === "runs" && <GlobalRunsView />}
        {activeSection === "events" && <GlobalEventsView />}
        {activeSection === "specs" && <AgentSpecsView />}
      </div>
    </main>
  </div>;
}

export function App() {
  const [data, setData] = useState<ProjectWorkbench | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    loadProjectWorkbench().then(
      (result) => { if (active) setData(result); },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { active = false; };
  }, []);
  if (error) return <main className="load-state"><div className="brand-mark">AS</div><h1>工作台加载失败</h1><p>{error}</p></main>;
  if (data === undefined) return <main className="load-state"><div className="brand-mark">AS</div><h1>正在加载工作台</h1><p>正在读取 Project、Run 和 Agent Instance 状态</p></main>;
  return <WorkbenchContext.Provider value={data}><WorkbenchPage data={data} /></WorkbenchContext.Provider>;
}
