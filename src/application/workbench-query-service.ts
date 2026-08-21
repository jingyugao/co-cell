import type {
  ProjectListResponse,
  ProjectWorkbench,
  ProjectRunsResponse,
  InboxEventsResponse,
  GlobalRunsResponse,
  GlobalInboxEventsResponse,
  AgentSpecUsage,
  AgentConversationResponse,
  AgentInstanceDetail,
  ProjectStatus,
  RunDetail,
  RunEventsResponse,
} from "../contracts/workbench.js";
import type { AgentConversationReader } from "../persistence/checkpoint-conversation-reader.js";
import {
  decodeProjectCursor,
  PostgresWorkbenchRepository,
} from "../persistence/workbench-repository.js";
import { InvalidRequestError, NotFoundError } from "./errors.js";

export interface SandboxRuntimeStatus {
  status: "online" | "offline" | "unknown";
  name: string;
  latencyMs: number | null;
}

export interface SandboxHealthProvider {
  getStatus(): Promise<SandboxRuntimeStatus>;
}

export interface WorkbenchQueries {
  ping(): Promise<void>;
  listProjects(options: { limit: number; cursor?: string; status?: ProjectStatus }): Promise<ProjectListResponse>;
  getProjectWorkbench(projectId: string): Promise<ProjectWorkbench>;
  getRun(runId: string): Promise<RunDetail>;
  listProjectRuns(projectId: string, options: { limit: number; cursor?: string }): Promise<ProjectRunsResponse>;
  listInboxEvents(projectId: string, options: { limit: number; cursor?: string }): Promise<InboxEventsResponse>;
  listRuns(options: { limit: number; cursor?: string }): Promise<GlobalRunsResponse>;
  listAllInboxEvents(options: { limit: number; cursor?: string }): Promise<GlobalInboxEventsResponse>;
  getAgentSpecUsage(specKey: string): Promise<AgentSpecUsage>;
  getAgentInstance(agentInstanceId: string): Promise<AgentInstanceDetail>;
  getAgentConversation(agentInstanceId: string): Promise<AgentConversationResponse>;
  getRunEvents(runId: string, afterSequence: number, limit: number): Promise<RunEventsResponse>;
}

export class WorkbenchQueryService implements WorkbenchQueries {
  constructor(
    private readonly repository: PostgresWorkbenchRepository,
    private readonly sandboxHealth: SandboxHealthProvider,
    private readonly conversationReader?: AgentConversationReader,
  ) {}

  ping(): Promise<void> {
    return this.repository.ping();
  }

  async listProjects(options: {
    limit: number;
    cursor?: string;
    status?: ProjectStatus;
  }): Promise<ProjectListResponse> {
    let cursor;
    try {
      cursor = options.cursor ? decodeProjectCursor(options.cursor) : undefined;
    } catch {
      throw new InvalidRequestError("cursor is invalid");
    }
    return this.repository.listProjects({
      limit: options.limit,
      cursor,
      status: options.status,
    });
  }

  async getProjectWorkbench(projectId: string): Promise<ProjectWorkbench> {
    const result = await this.repository.getProjectWorkbench(projectId);
    if (!result) throw new NotFoundError("Project");
    const runtime = await this.sandboxHealth.getStatus();
    return { ...result, runtime };
  }

  async getAgentInstance(agentInstanceId: string): Promise<AgentInstanceDetail> {
    const result = await this.repository.getAgentInstanceDetail(agentInstanceId);
    if (!result) throw new NotFoundError("Agent Instance");
    return result;
  }

  async getAgentConversation(agentInstanceId: string): Promise<AgentConversationResponse> {
    const instance = await this.repository.getAgentInstanceDetail(agentInstanceId);
    if (!instance) throw new NotFoundError("Agent Instance");
    if (!this.conversationReader) {
      return { threadId: instance.agentInstance.threadId, checkpointId: null, messages: [] };
    }
    return this.conversationReader.getConversation(instance.agentInstance.threadId);
  }

  async getRunEvents(
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<RunEventsResponse> {
    if (!(await this.repository.runExists(runId))) throw new NotFoundError("Run");
    return this.repository.getRunEvents(runId, afterSequence, limit);
  }

  async getRun(runId: string): Promise<RunDetail> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new NotFoundError("Run");
    return run;
  }

  async listProjectRuns(
    projectId: string,
    options: { limit: number; cursor?: string },
  ): Promise<ProjectRunsResponse> {
    await this.ensureProject(projectId);
    return this.repository.listProjectRuns({
      projectId,
      limit: options.limit,
      cursor: this.decodeCursor(options.cursor),
    });
  }

  async listInboxEvents(
    projectId: string,
    options: { limit: number; cursor?: string },
  ): Promise<InboxEventsResponse> {
    await this.ensureProject(projectId);
    return this.repository.listInboxEvents({
      projectId,
      limit: options.limit,
      cursor: this.decodeCursor(options.cursor),
    });
  }

  async listRuns(options: {
    limit: number;
    cursor?: string;
  }): Promise<GlobalRunsResponse> {
    return this.repository.listRuns({
      limit: options.limit,
      cursor: this.decodeCursor(options.cursor),
    });
  }

  async listAllInboxEvents(options: {
    limit: number;
    cursor?: string;
  }): Promise<GlobalInboxEventsResponse> {
    return this.repository.listAllInboxEvents({
      limit: options.limit,
      cursor: this.decodeCursor(options.cursor),
    });
  }

  getAgentSpecUsage(specKey: string): Promise<AgentSpecUsage> {
    return this.repository.getAgentSpecUsage(specKey);
  }

  private decodeCursor(cursor?: string) {
    if (!cursor) return undefined;
    try {
      return decodeProjectCursor(cursor);
    } catch {
      throw new InvalidRequestError("cursor is invalid");
    }
  }

  private async ensureProject(projectId: string): Promise<void> {
    if (!(await this.repository.projectExists(projectId))) {
      throw new NotFoundError("Project");
    }
  }
}
