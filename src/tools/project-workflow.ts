import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { tool } from "langchain";
import { z } from "zod";

import type { ProjectTask, ProjectTaskStatus } from "../contracts/collaboration.js";
import type { PostgresProjectCollaborationRepository } from "../persistence/project-collaboration-repository.js";

const TaskStatusSchema = z.enum([
  "pending", "assigned", "running", "blocked", "completed", "failed", "cancelled",
]);

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export interface ProjectWorkflowToolOptions {
  repository: PostgresProjectCollaborationRepository;
  projectId: string;
  agentSeatId: string;
  runId: string;
  workspaceRoot: string;
  listAgents(): Promise<Array<{
    seatId: string;
    specKey: string;
    responsibility: string;
    isCoordinator: boolean;
    status: string;
  }>>;
  sendAgentMessage(input: {
    targetAgentSeatId: string;
    message: string;
    taskId?: string;
  }): Promise<{ runId: string; status: "queued" | "notified" }>;
  onTaskAssigned(task: ProjectTask): Promise<void>;
  onPublished(publication: {
    id: string;
    kind: string;
    summary: string;
    relativePath: string;
    taskId: string | null;
  }): Promise<void>;
  appendRunEvent?: (input: {
    eventType: string;
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
  }) => Promise<void>;
}

export function createProjectWorkflowTools(options: ProjectWorkflowToolOptions) {
  const projectAgentList = tool(async () => json(await options.listAgents()), {
    name: "project_agent_list",
    description: "List active Agent Seats in the current project and their responsibilities.",
    schema: z.object({}),
  });

  const taskList = tool(async (input) => json(await options.repository.listTasks({
    projectId: options.projectId,
    ...(input.statuses?.length ? { statuses: input.statuses as ProjectTaskStatus[] } : {}),
    ...(input.assignee_seat_id
      ? { assigneeSeatId: input.assignee_seat_id }
      : {}),
  })), {
    name: "task_list",
    description: "List durable project tasks. Use this before creating work to avoid duplication.",
    schema: z.object({
      statuses: z.array(TaskStatusSchema).optional(),
      assignee_seat_id: z.string().uuid().optional(),
    }),
  });

  const taskGet = tool(async (input) => {
    const task = await options.repository.getTask(options.projectId, input.task_id);
    if (!task) throw new Error("Project Task was not found");
    return json(task);
  }, {
    name: "task_get",
    description: "Get one project task, including its scope, owner, state and result.",
    schema: z.object({ task_id: z.string().uuid() }),
  });

  const taskCreate = tool(async (input) => {
    const task = await options.repository.createTask({
      projectId: options.projectId,
      agentSeatId: options.agentSeatId,
      runId: options.runId,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.acceptance_criteria ? { acceptanceCriteria: input.acceptance_criteria } : {}),
      ...(input.parent_task_id ? { parentTaskId: input.parent_task_id } : {}),
      ...(input.assignee_seat_id
        ? { assigneeSeatId: input.assignee_seat_id }
        : {}),
    });
    if (task.assigneeSeatId && task.assigneeSeatId !== options.agentSeatId) {
      await options.onTaskAssigned(task);
    }
    await options.appendRunEvent?.({
      eventType: "task_created",
      title: "Agent 创建项目任务",
      detail: task.title,
      data: { taskId: task.id, assigneeSeatId: task.assigneeSeatId },
    });
    return json(task);
  }, {
    name: "task_create",
    description: "Create a durable project task with a clear scope and acceptance criteria.",
    schema: z.object({
      title: z.string().trim().min(1).max(500),
      description: z.string().trim().max(8_000).optional(),
      acceptance_criteria: z.string().trim().max(8_000).optional(),
      parent_task_id: z.string().uuid().optional(),
      assignee_seat_id: z.string().uuid().optional(),
    }),
  });

  const taskUpdate = tool(async (input) => {
    const assignmentProvided = Object.prototype.hasOwnProperty.call(input, "assignee_seat_id");
    if (input.status === "blocked" && !input.blocked_reason) {
      throw new Error("blocked_reason is required when a Task is blocked");
    }
    const before = await options.repository.getTask(options.projectId, input.task_id);
    if (!before) throw new Error("Project Task was not found");
    const effectiveStatus = input.status ??
      (assignmentProvided && input.assignee_seat_id ? "assigned" : undefined);
    const task = await options.repository.updateTask({
      projectId: options.projectId,
      taskId: input.task_id,
      ...(input.title ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.acceptance_criteria !== undefined
        ? { acceptanceCriteria: input.acceptance_criteria }
        : {}),
      ...(assignmentProvided
        ? { assigneeSeatId: input.assignee_seat_id ?? null }
        : {}),
      ...(effectiveStatus ? { status: effectiveStatus } : {}),
      ...(input.blocked_reason ? { blockedReason: input.blocked_reason } : {}),
      ...(input.result ? { result: input.result } : {}),
    });
    if (!task) throw new Error("Project Task or assignee was not found");
    const shouldActivateAssignee = task.assigneeSeatId &&
      task.assigneeSeatId !== options.agentSeatId &&
      (
        (assignmentProvided && task.assigneeSeatId !== before.assigneeSeatId) ||
        input.status === "assigned"
      );
    if (shouldActivateAssignee) {
      await options.onTaskAssigned(task);
    }
    await options.appendRunEvent?.({
      eventType: "task_updated",
      title: "Agent 更新项目任务",
      detail: `${task.title} · ${task.status}`,
      data: { taskId: task.id, status: task.status, assigneeSeatId: task.assigneeSeatId },
    });
    return json(task);
  }, {
    name: "task_update",
    description:
      "Update project task content, status, result or assignee. Changing the assignee " +
      "automatically notifies and activates that Agent; no separate dispatch tool is needed.",
    schema: z.object({
      task_id: z.string().uuid(),
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().trim().max(8_000).optional(),
      acceptance_criteria: z.string().trim().max(8_000).optional(),
      assignee_seat_id: z.string().uuid().nullable().optional(),
      status: TaskStatusSchema.optional(),
      blocked_reason: z.string().trim().min(1).max(4_000).optional(),
      result: z.string().trim().min(1).max(12_000).optional(),
    }).refine((value) => Object.keys(value).some((key) => key !== "task_id"), {
      message: "At least one Task field must be updated",
    }),
  });

  const chatAgent = tool(async (input) => json(await options.sendAgentMessage({
    targetAgentSeatId: input.target_seat_id,
    message: input.message,
    ...(input.task_id ? { taskId: input.task_id } : {}),
  })), {
    name: "chat_agent",
    description:
      "Send an asynchronous message to another Agent in this project. Use Task assignment " +
      "for ownership; use chat only for questions, context and coordination.",
    schema: z.object({
      target_seat_id: z.string().uuid(),
      message: z.string().trim().min(1).max(8_000),
      task_id: z.string().uuid().optional(),
    }),
  });

  const projectPublish = tool(async (input) => {
    const workspaceRoot = await realpath(resolve(options.workspaceRoot));
    const file = await realpath(resolve(workspaceRoot, input.path));
    if (!isWithin(workspaceRoot, file)) {
      throw new Error("Publication file is outside the Seat Workspace");
    }
    const content = await readFile(file, "utf8");
    if (!content.trim()) throw new Error("Publication file is empty");
    const relativePath = relative(workspaceRoot, file);
    const publication = await options.repository.savePublication({
      projectId: options.projectId,
      agentSeatId: options.agentSeatId,
      runId: options.runId,
      kind: input.kind,
      summary: input.summary,
      relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      ...(input.task_id ? { taskId: input.task_id } : {}),
    });
    await options.onPublished(publication);
    await options.appendRunEvent?.({
      eventType: "project_published",
      title: "Agent 发布项目内容",
      detail: publication.summary,
      data: { publicationId: publication.id, kind: publication.kind, path: relativePath },
    });
    return json(publication);
  }, {
    name: "project_publish",
    description:
      "Publish a reviewed project file as questions, progress, a phase result or a final result. " +
      "The project file is the source of truth; the tool records an immutable content revision.",
    schema: z.object({
      kind: z.enum(["questions", "progress", "phase_result", "final"]),
      path: z.string().trim().min(1).max(1_000),
      summary: z.string().trim().min(1).max(2_000),
      task_id: z.string().uuid().optional(),
    }),
  });

  return [
    projectAgentList,
    taskList,
    taskGet,
    taskCreate,
    taskUpdate,
    chatAgent,
    projectPublish,
  ];
}
