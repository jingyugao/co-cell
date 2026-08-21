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
  AgentAssignmentResult,
  FeishuWorkItemPreview,
} from "../../src/contracts/requirements";
import {
  createAgentAssignment,
  loadInboxEvents,
  loadAllRuns,
  loadAllInboxEvents,
  loadAgentSpecs,
  loadAgentInstance,
  loadAgentConversation,
  loadAgentSpecOverview,
  loadProjectRuns,
  loadProjects,
  loadProjectWorkbench,
  previewFeishuWorkItem,
  startAgentRun,
} from "./api";

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
  idle: "空闲",
  queued: "等待运行",
  running: "正在执行任务",
  waiting: "等待人工",
  disabled: "已停用",
  failed: "运行异常",
};

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

type MainSection = "import" | "requirements" | "instance" | "runs" | "events" | "specs";

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
    { key: "import" as const, icon: "+", label: "导入需求" },
    { key: "requirements" as const, icon: "▦", label: "需求列表", badge: String(projectCount) },
    { key: "runs" as const, icon: "◫", label: "运行记录", badge: String(statistics.totalRuns) },
    { key: "events" as const, icon: "↯", label: "事件中心" },
    { key: "specs" as const, icon: "◇", label: "Agent Specs" },
  ];
  return (
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">AS</div><div><strong>Agent Staff</strong><span>AI 员工平台</span></div></div>
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

function FeishuRequirementView({ onOpenRequirement }: { onOpenRequirement: (projectId: string) => void }) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<FeishuWorkItemPreview | null>(null);
  const [specs, setSpecs] = useState<AgentSpecSummary[]>([]);
  const [specKey, setSpecKey] = useState("software-engineer");
  const [role, setRole] = useState("");
  const [assignments, setAssignments] = useState<AgentAssignmentResult[]>([]);
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

  async function openRequirement(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setPreview(null);
    setAssignments([]);
    try {
      const result = await previewFeishuWorkItem(url.trim());
      setPreview(result);
      setAssignments(result.assignments);
      setRole(result.currentNodes[0]?.name ?? "backend");
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
      const assignment = await createAgentAssignment({
        url: preview.sourceUrl,
        specKey,
        role: role.trim(),
      });
      setAssignments((items) => [...items, assignment]);
      setRole("");
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
    <GlobalHeader eyebrow="REQUIREMENT IMPORT" title="导入飞书需求" description="读取飞书需求并绑定至少一个 Agent Instance；绑定完成即视为导入" />
    <section className="panel requirement-opener">
      <form className="url-form" onSubmit={openRequirement}>
        <label htmlFor="feishu-url">飞书项目需求地址</label>
        <div><input id="feishu-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://project.feishu.cn/space/story/detail/123456" /><button type="submit" disabled={loading}>{loading ? "读取中…" : "打开需求"}</button></div>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}
    </section>
    {preview && <div className="live-requirement-grid">
      <section className="panel live-requirement-card">
        <div className="live-source"><span className="health-dot" />飞书实时数据 <a href={preview.sourceUrl} target="_blank" rel="noreferrer">在飞书中打开 ↗</a></div>
        <div className="requirement-title"><div className="project-symbol">需</div><div><h2>{preview.title}</h2><p>{preview.project.name} · {preview.workItemType.name} #{preview.workItemId}</p></div><span className="project-status"><span />{preview.status?.name ?? "未知状态"}</span></div>
        <div className="node-list"><div className="eyebrow">CURRENT NODE</div>{preview.currentNodes.map((node) => <div className="node-item" key={node.id}><strong>{node.name}</strong><span>{node.owners.map((owner) => owner.name).join("、") || "未设置负责人"}</span></div>)}</div>
        <dl className="live-fields">{highlightedFields.map((field) => <DefinitionRow key={field.key} label={field.name}>{displayFieldValue(field.value)}</DefinitionRow>)}</dl>
        <div className="role-list"><div className="eyebrow">ROLES</div><div>{preview.roles.map((item) => <span key={item.key}><strong>{item.name}</strong>{item.members.map((member) => member.name).join("、") || "未分配"}</span>)}</div></div>
      </section>
      <section className="panel assignment-card">
        <div className="records-heading"><div><div className="eyebrow">AGENT ASSIGNMENT</div><h2>绑定开发 Agent</h2><p>首次绑定后需求将出现在需求列表；同一需求可以绑定多个 Agent Instance</p></div></div>
        <form className="assignment-form" onSubmit={assignAgent}>
          <label>Agent Spec<select value={specKey} onChange={(event) => setSpecKey(event.target.value)}>{specs.map((spec) => <option value={spec.id} key={spec.id}>{spec.name} · v{spec.version}</option>)}</select></label>
          <label>职责 / 模块<input required value={role} onChange={(event) => setRole(event.target.value)} placeholder="例如 backend-module-a" /></label>
          <button className="primary-button" type="submit" disabled={assigning}>{assigning ? "正在绑定…" : "绑定并导入"}</button>
        </form>
        <div className="assigned-list">
          {assignments.map((assignment) => {
            return <div className="assigned-agent" key={assignment.assignmentId}><div><strong>{assignment.agentInstance.role}</strong><span>{assignment.agentInstance.specKey} · Agent Instance</span><code>{assignment.agentInstance.id}</code></div><button type="button" onClick={() => onOpenRequirement(assignment.projectId)}>查看需求</button></div>;
          })}
          {assignments.length === 0 && <div className="empty-state compact-empty">尚未绑定 Agent；绑定后完成导入</div>}
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
  const { primaryAgentInstance: instance, latestInboxEvent: inbox, runtime } = useWorkbench();
  return (
    <aside className="detail-column" aria-label="Agent Instance 信息">
      <section className="panel instance-panel">
        <div className="instance-heading"><div className="instance-icon">AI</div><div><div className="eyebrow">AGENT INSTANCE</div><h2>研发员工实例</h2></div><span className={instance?.status === "running" ? "live-indicator" : "idle-indicator"} /></div>
        {instance ? (
          <>
            <div className="instance-state-card"><div><span>当前状态</span><strong>{instanceStatusLabels[instance.status]}</strong></div>{instance.status === "running" && <span className="pulse-bars" aria-hidden="true"><i /><i /><i /></span>}</div>
            <dl className="definition-list">
              <DefinitionRow label="Instance ID"><code>{instance.id}</code></DefinitionRow>
              <DefinitionRow label="Agent Spec"><span className="spec-chip">{instance.specKey}</span><span className="version-chip">v{instance.specVersion}</span></DefinitionRow>
              <DefinitionRow label="Workspace"><code className="path-code">{instance.workspaceKey}</code></DefinitionRow>
              <DefinitionRow label="Thread ID"><code className="path-code">{instance.threadId}</code></DefinitionRow>
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
  const { project, primaryAgentInstance: instance, runtime } = useWorkbench();
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
          <DefinitionRow label="Instance ID"><code>{instance?.id ?? "—"}</code></DefinitionRow>
          <DefinitionRow label="Agent Spec">{instance ? `${instance.specKey} · v${instance.specVersion}` : "—"}</DefinitionRow>
          <DefinitionRow label="Instance 状态">{instance ? instanceStatusLabels[instance.status] : "未绑定"}</DefinitionRow>
          <DefinitionRow label="Workspace"><code>{instance?.workspaceKey ?? "—"}</code></DefinitionRow>
          <DefinitionRow label="Thread ID"><code>{instance?.threadId ?? "—"}</code></DefinitionRow>
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
  useEffect(() => {
    let active = true;
    loadAgentSpecs().then((result) =>
      Promise.all(result.items.map((spec) => loadAgentSpecOverview(spec.id))),
    ).then(
      (result) => { if (active) setData(result); },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { active = false; };
  }, []);
  return <>
    <GlobalHeader eyebrow="AGENT CATALOG" title="Agent Specs" description="查看 Agent 的能力定义，以及每个 Spec 当前参与的研发需求" />
    {error ? <section className="panel empty-state error-state">{error}</section> : !data ? <section className="panel empty-state">正在读取 Agent Specs…</section> : (
      <div className="spec-grid">
        {data.map(({ spec, statistics, activeRequirements }) => (
          <section className="panel spec-card" key={spec.id}>
            <div className="spec-card-heading">
              <div className="instance-icon">AI</div>
              <div><h2>{spec.name}</h2><code>{spec.id}</code></div>
              <span className="version-chip">v{spec.version}</span>
            </div>
            <div className="spec-metrics" aria-label={`${spec.name} 使用情况`}>
              <div><strong>{statistics.instances}</strong><span>Agent Instances</span></div>
              <div><strong>{statistics.activeRequirements}</strong><span>进行中需求</span></div>
              <div><strong>{statistics.runningInstances}</strong><span>运行中实例</span></div>
            </div>
            <dl className="basic-definition-list spec-definition-list">
              <DefinitionRow label="Sandbox Image"><code>{spec.sandbox.image}</code></DefinitionRow>
              <DefinitionRow label="Dockerfile"><code>{spec.sandbox.dockerfile}</code></DefinitionRow>
              <DefinitionRow label="Environment"><code>{spec.environmentExample}</code></DefinitionRow>
              <DefinitionRow label="知识模块">{spec.knowledge.length} 个</DefinitionRow>
            </dl>
            <div className="knowledge-list">{spec.knowledge.map((knowledge) => <span key={`${knowledge.path}-${knowledge.when ?? "always"}`}><code>{knowledge.path}</code>{knowledge.when && <em>需要 {knowledge.when}</em>}</span>)}</div>
            <div className="requirements-heading"><div><div className="eyebrow">ACTIVE REQUIREMENTS</div><h3>进行中的 Agent 需求</h3></div><span>{activeRequirements.length} 个关联</span></div>
            <div className="requirements-table" aria-label={`${spec.name} 进行中的需求`}>
              <div className="requirement-row requirement-header"><span>需求</span><span>职责</span><span>Agent Instance</span><span>当前状态</span><span>最近活跃</span></div>
              {activeRequirements.map((requirement) => (
                <div className="requirement-row" key={requirement.associationId}>
                  <div className="record-primary"><strong>{requirement.project.name ?? requirement.project.externalProjectId}</strong><code>{requirement.project.externalProjectId}</code></div>
                  <span className="role-chip">{requirement.role}{requirement.isPrimary && <em>主</em>}</span>
                  <div className="record-primary"><strong>{requirement.agentInstance.workspaceKey}</strong><code>{requirement.agentInstance.id}</code></div>
                  <span className={`event-status event-status-${requirement.currentRun?.status ?? requirement.agentInstance.status}`}><i />{requirement.currentRun ? runStatusLabels[requirement.currentRun.status] : instanceStatusLabels[requirement.agentInstance.status]}</span>
                  <span>{formatDate(requirement.agentInstance.lastActiveAt ?? requirement.boundAt)}</span>
                </div>
              ))}
              {activeRequirements.length === 0 && <div className="empty-state compact-empty">当前没有进行中的需求</div>}
            </div>
          </section>
        ))}
      </div>
    )}
  </>;
}

function RequirementListView({ initialProjectId, onOpenAgent }: { initialProjectId: string | null; onOpenAgent: (agentInstanceId: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [previews, setPreviews] = useState<Record<string, FeishuWorkItemPreview>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProjectId);
  const [starting, setStarting] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadProjects().then(async (response) => {
      if (!active) return;
      const requirements = response.items.filter(
        (project) => project.source === "feishu_project" && project.externalUrl,
      );
      setProjects(requirements);
      const loaded = await Promise.all(requirements.map(async (project) => {
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

  useEffect(() => {
    if (initialProjectId) setSelectedProjectId(initialProjectId);
  }, [initialProjectId]);

  async function start(assignment: AgentAssignmentResult) {
    setStarting(assignment.assignmentId);
    setError(null);
    try {
      await startAgentRun(assignment.assignmentId);
      onOpenAgent(assignment.agentInstance.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarting(null);
    }
  }

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selected = selectedProjectId ? previews[selectedProjectId] : undefined;
  if (selectedProjectId && selectedProject && !selected && loading) {
    return <div className="empty-state">正在读取需求详情…</div>;
  }
  if (selectedProjectId && selected) {
    const highlightedFields = selected.fields.filter((field) => ["描述", "优先级", "预计上车版本", "标签"].includes(field.name));
    return <>
      <button className="back-button" type="button" onClick={() => setSelectedProjectId(null)}>← 返回需求列表</button>
      <GlobalHeader eyebrow="REQUIREMENT DETAIL" title={selected.title} description={`${selected.project.name} · ${selected.workItemType.name} #${selected.workItemId}`} />
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="live-requirement-grid requirement-detail-grid">
        <section className="panel live-requirement-card">
          <div className="live-source"><span className="health-dot" />飞书实时数据 <a href={selected.sourceUrl} target="_blank" rel="noreferrer">在飞书中打开 ↗</a></div>
          <div className="requirement-title"><div className="project-symbol">需</div><div><h2>{selected.title}</h2><p>{selected.project.name} · #{selected.workItemId}</p></div><span className="project-status"><span />{selected.status?.name ?? "未知状态"}</span></div>
          <div className="node-list"><div className="eyebrow">CURRENT NODE</div>{selected.currentNodes.map((node) => <div className="node-item" key={node.id}><strong>{node.name}</strong><span>{node.owners.map((owner) => owner.name).join("、") || "未设置负责人"}</span></div>)}</div>
          <dl className="live-fields">{highlightedFields.map((field) => <DefinitionRow key={field.key} label={field.name}>{displayFieldValue(field.value)}</DefinitionRow>)}</dl>
        </section>
        <section className="panel assignment-card">
          <div className="records-heading"><div><div className="eyebrow">AGENT INSTANCES</div><h2>需求 Agent</h2><p>查看职责与运行状态；空闲实例可直接启动</p></div></div>
          <div className="assigned-list requirement-agent-list">
            {selected.assignments.map((assignment) => {
              const canStart = assignment.agentInstance.status === "idle" || assignment.agentInstance.status === "failed";
              return <div className="assigned-agent" key={assignment.assignmentId}><div><strong>{assignment.agentInstance.role}</strong><span>{assignment.agentInstance.specKey} · {instanceStatusLabels[assignment.agentInstance.status]}</span><code>{assignment.agentInstance.id}</code></div><div className="assigned-agent-actions"><button className="secondary-button" type="button" onClick={() => onOpenAgent(assignment.agentInstance.id)}>查看 Agent</button>{canStart && <button type="button" onClick={() => void start(assignment)} disabled={starting === assignment.assignmentId}>{starting === assignment.assignmentId ? "正在唤醒…" : "启动 Agent"}</button>}</div></div>;
            })}
            {selected.assignments.length === 0 && <div className="empty-state">该需求尚未绑定 Agent</div>}
          </div>
        </section>
      </div>
    </>;
  }

  return <>
    <GlobalHeader eyebrow="REQUIREMENTS" title="需求列表" description="所有已绑定 Agent Instance、完成导入的需求" />
    {error && <div className="form-error" role="alert">{error}</div>}
    <section className="panel project-directory">
      <div className="project-directory-heading"><div><h2>已导入需求</h2><p>点击需求进入详情并管理关联 Agent</p></div><span>{projects.length} 个</span></div>
      <div className="project-directory-list">
        {projects.map((project) => {
          const preview = previews[project.id];
          const title = preview?.title ?? project.name ?? `飞书需求 #${project.externalProjectId}`;
          return <button type="button" className="project-directory-item" key={project.id} onClick={() => setSelectedProjectId(project.id)}><span className="project-directory-symbol">需</span><span className="project-directory-main"><strong>{title}</strong><small>{preview?.status?.name ?? "飞书项目"} · {project.externalProjectId}</small></span><span>{preview?.assignments.length ?? (project.agentInstance ? 1 : 0)} 个 Agent</span></button>;
        })}
        {loading && <div className="empty-state">正在读取需求…</div>}
        {!loading && projects.length === 0 && <div className="empty-state">尚未导入需求，请先从“导入需求”绑定 Agent</div>}
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

function AgentInstanceDetailView({ agentInstanceId, onBack }: { agentInstanceId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<AgentInstanceDetail | null>(null);
  const [conversation, setConversation] = useState<AgentConversationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      let shouldPoll = true;
      try {
        const [instance, messages] = await Promise.all([
          loadAgentInstance(agentInstanceId),
          loadAgentConversation(agentInstanceId),
        ]);
        if (active) {
          setDetail(instance);
          setConversation((current) =>
            current?.checkpointId === messages.checkpointId ? current : messages,
          );
          setError(null);
          shouldPoll = instance.agentInstance.status === "queued" ||
            instance.agentInstance.status === "running";
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
  }, [agentInstanceId]);
  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!detail) return <div className="empty-state">正在读取 Agent Instance…</div>;
  const instance = detail.agentInstance;
  return <>
    <button className="back-button" type="button" onClick={onBack}>← 返回需求详情</button>
    <GlobalHeader eyebrow="AGENT INSTANCE" title={detail.assignment?.role ?? "Agent Instance"} description={`${instance.specKey} · ${instance.id}`} />
    <div className="agent-detail-grid">
      <section className="panel instance-panel">
        <div className="instance-heading"><div className="instance-icon">AI</div><div><div className="eyebrow">AGENT INSTANCE</div><h2>{detail.assignment?.role ?? instance.specKey}</h2></div><span className={instance.status === "running" ? "live-indicator" : "idle-indicator"} /></div>
        <div className="instance-state-card"><div><span>当前状态</span><strong>{instanceStatusLabels[instance.status]}</strong></div></div>
        <dl className="definition-list"><DefinitionRow label="Instance ID"><code>{instance.id}</code></DefinitionRow><DefinitionRow label="Agent Spec">{instance.specKey} · v{instance.specVersion}</DefinitionRow><DefinitionRow label="Workspace"><code>{instance.workspaceKey}</code></DefinitionRow><DefinitionRow label="Thread ID"><code>{instance.threadId}</code></DefinitionRow><DefinitionRow label="最近活跃">{formatDate(instance.lastActiveAt)}</DefinitionRow></dl>
      </section>
      <ConversationPanel conversation={conversation} runStatus={detail.currentRun?.status ?? null} />
    </div>
    <section className="panel recent-panel agent-run-history"><div className="panel-header compact-header"><div><div className="eyebrow">RUN HISTORY</div><h2>运行记录</h2></div><span className="muted-count">{detail.recentRuns.length} 次</span></div><div className="run-list">{detail.recentRuns.map((run) => <div className="run-row" key={run.id}><code>{run.id.slice(0, 8)}</code><div className="run-description"><strong>{run.taskSummary ?? "未命名任务"}</strong><span>{formatDate(run.createdAt)}</span></div><span className="run-duration">{formatDuration(run.durationSeconds)}</span><StatusBadge status={run.status} /></div>)}{detail.recentRuns.length === 0 && <div className="empty-state">尚无运行记录</div>}</div></section>
  </>;
}

function WorkbenchPage({ data }: { data: ProjectWorkbench | null }) {
  const [activeSection, setActiveSection] = useState<MainSection>("import");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgentInstanceId, setSelectedAgentInstanceId] = useState<string | null>(null);
  function openRequirement(projectId: string) { setSelectedProjectId(projectId); setActiveSection("requirements"); }
  function openAgent(agentInstanceId: string) { setSelectedAgentInstanceId(agentInstanceId); setActiveSection("instance"); }
  function changeSection(section: MainSection) {
    if (section === "requirements") setSelectedProjectId(null);
    setActiveSection(section);
  }
  const sectionTitle = activeSection === "import" ? "导入需求" : activeSection === "requirements" ? "需求列表" : activeSection === "instance" ? "Agent Instance" : activeSection === "runs" ? "运行记录" : activeSection === "events" ? "事件中心" : "Agent Specs";
  return <div className="app-shell">
    <Sidebar active={activeSection} onChange={changeSection} />
    <main className="workspace">
      <header className="topbar"><div className="breadcrumbs"><span>工作台</span><span className="breadcrumb-separator">/</span><strong>{sectionTitle}</strong></div><div className="topbar-meta">{activeSection !== "import" && <span className="readonly-badge"><Glyph>◉</Glyph>{activeSection === "requirements" || activeSection === "instance" ? "实时状态" : "只读视图"}</span>}</div></header>
      <div className="page-content">
        {activeSection === "import" && <FeishuRequirementView onOpenRequirement={openRequirement} />}
        {activeSection === "requirements" && <RequirementListView initialProjectId={selectedProjectId} onOpenAgent={openAgent} />}
        {activeSection === "instance" && selectedAgentInstanceId && <AgentInstanceDetailView agentInstanceId={selectedAgentInstanceId} onBack={() => setActiveSection("requirements")} />}
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
