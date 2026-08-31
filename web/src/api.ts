import type {
  ProjectListResponse,
  ProjectRunsResponse,
  ProjectWorkbench,
  InboxEventsResponse,
  GlobalRunsResponse,
  GlobalInboxEventsResponse,
  AgentSpecsResponse,
  AgentSpecOverviewResponse,
  AgentInstanceDetail,
  AgentConversationResponse,
} from "../../src/contracts/workbench";
import type {
  AgentSeatResult,
  CancelAgentRunResult,
  FeishuWorkItemPreview,
  StartAgentRunResult,
  ResumeAgentRunInput,
  ResumeAgentRunResult,
} from "../../src/contracts/projects";
import { readWorkbenchRoute } from "./navigation";

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(body.error?.message || `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const responseBody = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(responseBody.error?.message || `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export async function loadProjectWorkbench(): Promise<ProjectWorkbench | null> {
  const requestedProjectId = readWorkbenchRoute(new URL(window.location.href)).projectId;
  let projectId = requestedProjectId;
  if (!projectId) {
    const projects = await getJson<ProjectListResponse>("/api/v1/projects?limit=1");
    projectId = projects.items[0]?.id ?? null;
  }
  if (!projectId) return null;
  return getJson<ProjectWorkbench>(`/api/v1/projects/${encodeURIComponent(projectId)}/workbench`);
}

export function loadProjects(): Promise<ProjectListResponse> {
  return getJson<ProjectListResponse>("/api/v1/projects?limit=100");
}

export function loadProjectRuns(projectId: string): Promise<ProjectRunsResponse> {
  return getJson<ProjectRunsResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/runs?limit=100`,
  );
}

export function loadInboxEvents(projectId: string): Promise<InboxEventsResponse> {
  return getJson<InboxEventsResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/inbox-events?limit=100`,
  );
}

export function loadAllRuns(): Promise<GlobalRunsResponse> {
  return getJson<GlobalRunsResponse>("/api/v1/runs?limit=100");
}

export function loadAllInboxEvents(): Promise<GlobalInboxEventsResponse> {
  return getJson<GlobalInboxEventsResponse>("/api/v1/inbox-events?limit=100");
}

export function loadAgentSpecs(): Promise<AgentSpecsResponse> {
  return getJson<AgentSpecsResponse>("/api/v1/agent-specs");
}

export function loadAgentSpecOverview(specKey: string): Promise<AgentSpecOverviewResponse> {
  return getJson<AgentSpecOverviewResponse>(
    `/api/v1/agent-specs/${encodeURIComponent(specKey)}`,
  );
}

export function loadAgentInstance(agentInstanceId: string): Promise<AgentInstanceDetail> {
  return getJson<AgentInstanceDetail>(
    `/api/v1/agent-instances/${encodeURIComponent(agentInstanceId)}`,
  );
}

export function loadAgentSeat(agentSeatId: string): Promise<AgentInstanceDetail> {
  return getJson<AgentInstanceDetail>(
    `/api/v1/agent-seats/${encodeURIComponent(agentSeatId)}`,
  );
}

export function loadAgentConversation(agentSessionId: string): Promise<AgentConversationResponse> {
  return getJson<AgentConversationResponse>(
    `/api/v1/agent-sessions/${encodeURIComponent(agentSessionId)}/conversation`,
  );
}

export function previewFeishuWorkItem(url: string): Promise<FeishuWorkItemPreview> {
  return postJson<FeishuWorkItemPreview>("/api/v1/feishu-project/work-items/preview", { url });
}

export function createAgentSeat(input: {
  url: string;
  specKey: string;
  responsibility: string;
  isCoordinator?: boolean;
}): Promise<AgentSeatResult> {
  return postJson<AgentSeatResult>("/api/v1/agent-seats", input);
}

export function startAgentRun(seatId: string): Promise<StartAgentRunResult> {
  return postJson<StartAgentRunResult>(
    `/api/v1/agent-seats/${encodeURIComponent(seatId)}/runs`,
    {},
  );
}

export function cancelAgentRun(runId: string): Promise<CancelAgentRunResult> {
  return postJson<CancelAgentRunResult>(
    `/api/v1/runs/${encodeURIComponent(runId)}/cancel`,
    {},
  );
}

export function resumeAgentRun(
  runId: string,
  input: ResumeAgentRunInput,
): Promise<ResumeAgentRunResult> {
  return postJson<ResumeAgentRunResult>(
    `/api/v1/runs/${encodeURIComponent(runId)}/resume`,
    input,
  );
}
