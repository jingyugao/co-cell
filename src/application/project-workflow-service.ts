import type {
  AgentSeatResult,
  CancelAgentRunResult,
  FeishuWorkItemPreview,
  ResumeAgentRunInput,
  ResumeAgentRunResult,
  StartAgentRunResult,
  ProjectMessageResult,
} from "../contracts/projects.js";
import type { FeishuProjectWorkItemDetails } from "../integrations/feishu-project-mcp.js";
import { parseFeishuProjectWorkItemUrl } from "../integrations/feishu-project-mcp.js";
import type { PostgresWorkbenchRepository } from "../persistence/workbench-repository.js";
import { NotFoundError } from "./errors.js";
import type { AgentSpecCatalog } from "../server/agent-spec-catalog.js";
import type { PostgresProjectEventBus } from "../events/project-event-bus.js";

type UnknownRecord = Record<string, unknown>;

function object(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function named(value: unknown): { key: string; name: string } | null {
  const item = object(value);
  const key = text(item.key);
  const name = text(item.name);
  return key || name ? { key, name } : null;
}

function namedPeople(value: unknown): Array<{ key: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.map(named).filter((item): item is { key: string; name: string } => Boolean(item));
}

export interface FeishuWorkItemSource {
  get(url: string): Promise<{
    preview: FeishuWorkItemPreview;
    raw: FeishuProjectWorkItemDetails;
  }>;
}

export class McpFeishuWorkItemSource implements FeishuWorkItemSource {
  constructor(
    private readonly load: (url: string) => Promise<FeishuProjectWorkItemDetails>,
  ) {}

  async get(sourceUrl: string) {
    const parsed = parseFeishuProjectWorkItemUrl(sourceUrl);
    const raw = await this.load(sourceUrl);
    const attribute = object(raw.work_item_attribute);
    const ownedProject = object(attribute.owned_project);
    const workItemType = named(attribute.work_item_type) ?? {
      key: parsed.workItemType,
      name: parsed.workItemType,
    };
    const status = named(attribute.work_item_status);
    const roles = Array.isArray(attribute.role_members)
      ? attribute.role_members.map((value) => {
          const role = object(value);
          return {
            key: text(role.key),
            name: text(role.name),
            members: namedPeople(role.members),
          };
        })
      : [];
    const currentNodes = raw.work_item_current_node.map((value) => {
      const node = object(value);
      return {
        id: text(node.id),
        name: text(node.name),
        owners: namedPeople(node.owners),
        actualBeginTime:
          typeof node.actual_begin_time === "string" ? node.actual_begin_time : null,
      };
    });
    return {
      raw,
      preview: {
        sourceUrl,
        projectKey: text(ownedProject.key) || parsed.projectKey,
        project: {
          key: text(ownedProject.key) || parsed.projectKey,
          simpleName: text(ownedProject.simple_name) || parsed.projectKey,
          name: text(ownedProject.name) || parsed.projectKey,
        },
        workItemId: text(attribute.work_item_id) || parsed.workItemId,
        workItemType,
        title: text(attribute.work_item_name) || `Work item ${parsed.workItemId}`,
        status,
        roles,
        currentNodes,
        fields: raw.work_item_fields.map((field) => ({
          key: field.key,
          name: field.name,
          value: field.value,
        })),
        updatedAt:
          typeof attribute.update_time === "string" ? attribute.update_time : null,
        seats: [],
      },
    };
  }
}

export interface AgentRunLauncher {
  launch(runId: string): void;
  notify(runId: string): void;
  resume(runId: string, input: ResumeAgentRunInput): Promise<ResumeAgentRunResult>;
  cancel(runId: string): Promise<CancelAgentRunResult>;
}

export interface ProjectWorkflow {
  preview(url: string): Promise<FeishuWorkItemPreview>;
  assignSeat(input: {
    url: string;
    specKey: string;
    responsibility: string;
    isCoordinator?: boolean;
  }): Promise<AgentSeatResult>;
  start(seatId: string): Promise<StartAgentRunResult>;
  resume(runId: string, input: ResumeAgentRunInput): Promise<ResumeAgentRunResult>;
  cancel(runId: string): Promise<CancelAgentRunResult>;
  message(projectId: string, input: ResumeAgentRunInput): Promise<ProjectMessageResult>;
}

export class ProjectWorkflowService implements ProjectWorkflow {
  constructor(
    private readonly source: FeishuWorkItemSource,
    private readonly repository: PostgresWorkbenchRepository,
    private readonly specs: AgentSpecCatalog,
    private readonly launcher: AgentRunLauncher,
    private readonly eventBus?: PostgresProjectEventBus,
  ) {}

  async preview(url: string): Promise<FeishuWorkItemPreview> {
    const { preview } = await this.source.get(url);
    const seats = await this.repository.listAgentSeats({
      externalProjectKey: preview.projectKey,
      externalWorkItemType: preview.workItemType.key,
      externalWorkItemId: preview.workItemId,
    });
    return { ...preview, seats };
  }

  async assignSeat(input: {
    url: string;
    specKey: string;
    responsibility: string;
    isCoordinator?: boolean;
  }): Promise<AgentSeatResult> {
    const spec = await this.specs.get(input.specKey);
    if (!spec) throw new NotFoundError("Agent Spec");
    const { preview } = await this.source.get(input.url);
    return this.repository.createAgentSeat({
      sourceUrl: preview.sourceUrl,
      externalProjectKey: preview.projectKey,
      externalWorkItemType: preview.workItemType.key,
      externalWorkItemId: preview.workItemId,
      specKey: spec.id,
      specVersion: spec.version,
      responsibility: input.responsibility,
      isCoordinator: input.isCoordinator ?? true,
    });
  }

  async start(seatId: string): Promise<StartAgentRunResult> {
    const result = await this.repository.createAgentRun(seatId, { sessionMode: "fresh" });
    queueMicrotask(() => this.launcher.launch(result.runId));
    return result;
  }

  resume(runId: string, input: ResumeAgentRunInput): Promise<ResumeAgentRunResult> {
    return this.launcher.resume(runId, input);
  }

  cancel(runId: string): Promise<CancelAgentRunResult> {
    return this.launcher.cancel(runId);
  }

  async message(projectId: string, input: ResumeAgentRunInput): Promise<ProjectMessageResult> {
    if (!this.eventBus) throw new NotFoundError("Project event bus");
    const seat = await this.repository.getCoordinatorSeat(projectId);
    if (!seat) throw new NotFoundError("Project Coordinator");
    await this.eventBus.publishProjectEvent({
      projectId,
      source: "swarm_hive_ui",
      eventType: "user_message_received",
      payload: { message: input.message },
    });
    const target = await this.eventBus.findDispatchTarget(projectId);
    if (target) {
      this.launcher.notify(target.runId);
      return { projectId, runId: target.runId, status: "notified" };
    }
    const run = await this.repository.createAgentRun(seat.seatId);
    queueMicrotask(() => this.launcher.launch(run.runId));
    return { projectId, runId: run.runId, status: "queued" };
  }
}
