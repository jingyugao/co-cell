import { randomUUID } from "node:crypto";

import type {
  AgentAssignmentResult,
  CancelAgentRunResult,
  FeishuWorkItemPreview,
  ResumeAgentRunInput,
  ResumeAgentRunResult,
  StartAgentRunResult,
} from "../contracts/requirements.js";
import type { FeishuProjectWorkItemDetails } from "../integrations/feishu-project-mcp.js";
import { parseFeishuProjectWorkItemUrl } from "../integrations/feishu-project-mcp.js";
import type { PostgresWorkbenchRepository } from "../persistence/workbench-repository.js";
import { NotFoundError } from "./errors.js";
import type { AgentSpecCatalog } from "../server/agent-spec-catalog.js";

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
        assignments: [],
      },
    };
  }
}

export interface AgentRunLauncher {
  launch(runId: string): void;
  resume(runId: string, input: ResumeAgentRunInput): Promise<ResumeAgentRunResult>;
  cancel(runId: string): Promise<CancelAgentRunResult>;
}

export interface RequirementWorkflow {
  preview(url: string): Promise<FeishuWorkItemPreview>;
  assign(input: {
    url: string;
    specKey: string;
    role: string;
  }): Promise<AgentAssignmentResult>;
  start(assignmentId: string): Promise<StartAgentRunResult>;
  resume(runId: string, input: ResumeAgentRunInput): Promise<ResumeAgentRunResult>;
  cancel(runId: string): Promise<CancelAgentRunResult>;
}

export class RequirementWorkflowService implements RequirementWorkflow {
  constructor(
    private readonly source: FeishuWorkItemSource,
    private readonly repository: PostgresWorkbenchRepository,
    private readonly specs: AgentSpecCatalog,
    private readonly launcher: AgentRunLauncher,
  ) {}

  async preview(url: string): Promise<FeishuWorkItemPreview> {
    const { preview } = await this.source.get(url);
    const assignments = await this.repository.listAgentAssignments({
      externalProjectKey: preview.projectKey,
      externalWorkItemType: preview.workItemType.key,
      externalWorkItemId: preview.workItemId,
    });
    return { ...preview, assignments };
  }

  async assign(input: {
    url: string;
    specKey: string;
    role: string;
  }): Promise<AgentAssignmentResult> {
    const spec = await this.specs.get(input.specKey);
    if (!spec) throw new NotFoundError("Agent Spec");
    const { preview } = await this.source.get(input.url);
    const unique = randomUUID();
    return this.repository.createAgentAssignment({
      sourceUrl: preview.sourceUrl,
      externalProjectKey: preview.projectKey,
      externalWorkItemType: preview.workItemType.key,
      externalWorkItemId: preview.workItemId,
      specKey: spec.id,
      specVersion: spec.version,
      role: input.role,
      threadId: `feishu:${preview.projectKey}:${preview.workItemType.key}:${preview.workItemId}:${unique}`,
      workspaceKey: `feishu-${preview.workItemId}-${unique.slice(0, 8)}`,
    });
  }

  async start(assignmentId: string): Promise<StartAgentRunResult> {
    const result = await this.repository.createAgentRun(assignmentId);
    queueMicrotask(() => this.launcher.launch(result.runId));
    return result;
  }

  resume(runId: string, input: ResumeAgentRunInput): Promise<ResumeAgentRunResult> {
    return this.launcher.resume(runId, input);
  }

  cancel(runId: string): Promise<CancelAgentRunResult> {
    return this.launcher.cancel(runId);
  }
}
