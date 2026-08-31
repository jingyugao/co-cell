import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { ProjectTask } from "../src/contracts/collaboration.js";
import type { PostgresProjectCollaborationRepository } from "../src/persistence/project-collaboration-repository.js";
import { createProjectTools } from "../src/tools/project/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const agentSeatId = "22222222-2222-4222-8222-222222222222";
const targetSeatId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const taskId = "55555555-5555-4555-8555-555555555555";

function task(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: taskId,
    projectId,
    parentTaskId: null,
    createdBySeatId: agentSeatId,
    assigneeSeatId: targetSeatId,
    createdByRunId: runId,
    title: "实现查询接口",
    description: "",
    acceptanceCriteria: "测试通过",
    status: "assigned",
    blockedReason: null,
    result: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function tools(input: {
  repository?: Partial<PostgresProjectCollaborationRepository>;
  workspaceRoot?: string;
  onTaskAssigned?: (task: ProjectTask) => Promise<void>;
  sendAgentMessage?: (input: {
    targetAgentSeatId: string;
    message: string;
    taskId?: string;
  }) => Promise<{ runId: string; status: "queued" | "notified" }>;
  onPublished?: (publication: {
    id: string;
    kind: string;
    summary: string;
    relativePath: string;
    taskId: string | null;
  }) => Promise<void>;
  isCoordinator?: boolean;
  listBindableAgentSpecs?: () => Promise<Array<{
    id: string;
    name: string;
    version: number;
    defaultResponsibility: string;
  }>>;
  bindAgent?: (input: { specKey: string; responsibility: string }) => Promise<import("../src/contracts/projects.js").AgentSeatResult>;
  releaseAgent?: (input: { seatId: string; reason: string }) => Promise<{ seatId: string; status: "released"; reason: string }>;
} = {}) {
  return createProjectTools({
    repository: input.repository as PostgresProjectCollaborationRepository,
    projectId,
    agentSeatId,
    runId,
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    isCoordinator: input.isCoordinator ?? true,
    listBindableAgentSpecs: input.listBindableAgentSpecs ?? vi.fn(async () => [{
      id: "software-engineer",
      name: "Software Engineer",
      version: 13,
      defaultResponsibility: "代码开发、自测、环境验证和 Merge Request 交付",
    }]),
    getProject: vi.fn(async () => ({
      project: {
        id: projectId,
        source: "feishu_project",
        sourceUrl: "https://project.feishu.cn/test/story/detail/1",
        externalProjectId: "1",
        status: "active",
      },
      seat: {
        id: agentSeatId,
        specKey: "project-coordinator",
        defaultResponsibility: "项目统筹与交付",
        responsibility: "coordinator",
        effectiveResponsibility: "项目统筹与交付；当前项目分工：coordinator",
        isCoordinator: input.isCoordinator ?? true,
      },
    })),
    listAgents: vi.fn(async () => []),
    bindAgent: input.bindAgent ?? vi.fn(async ({ specKey, responsibility }) => ({
      projectId,
      seatId: targetSeatId,
      responsibility,
      isCoordinator: false,
      workspaceKey: `seat:${targetSeatId}`,
      agentInstance: {
        id: "77777777-7777-4777-8777-777777777777",
        specKey,
        specVersion: 1,
        instanceKey: "default",
        status: "active" as const,
      },
      session: {
        id: "88888888-8888-4888-8888-888888888888",
        threadId: `agent-seat:${targetSeatId}`,
        status: "active" as const,
      },
      currentRun: null,
    })),
    releaseAgent: input.releaseAgent ?? vi.fn(async ({ seatId, reason }) => ({
      seatId,
      status: "released" as const,
      reason,
    })),
    sendAgentMessage: input.sendAgentMessage ?? vi.fn(async () => ({
      runId,
      status: "queued" as const,
    })),
    onTaskAssigned: input.onTaskAssigned ?? vi.fn(async () => undefined),
    onPublished: input.onPublished ?? vi.fn(async () => undefined),
  });
}

describe("project workflow tools", () => {
  test("exposes the compact project collaboration tool set", () => {
    expect(tools().map((item) => item.name)).toEqual([
      "project_get",
      "project_file_write",
      "project_agent_list",
      "task_list",
      "task_get",
      "task_create",
      "task_update",
      "chat_agent",
      "project_publish",
      "project_agent_catalog",
      "project_agent_bind",
      "project_agent_release",
    ]);
  });

  test("lists bindable Agent Specs before staffing a project", async () => {
    const listBindableAgentSpecs = vi.fn(async () => [{
      id: "software-engineer",
      name: "Software Engineer",
      version: 13,
      defaultResponsibility: "代码开发、自测、环境验证和 Merge Request 交付",
    }]);
    const catalog = tools({ listBindableAgentSpecs })
      .find((item) => item.name === "project_agent_catalog");
    expect(catalog).toBeTruthy();
    await expect(catalog!.invoke({})).resolves.toContain("software-engineer");
    expect(listBindableAgentSpecs).toHaveBeenCalledOnce();
  });

  test("reserves Agent staffing tools for the Project Coordinator", () => {
    expect(tools({ isCoordinator: false }).map((item) => item.name)).toEqual([
      "project_get",
      "project_file_write",
      "project_agent_list",
      "task_list",
      "task_get",
      "task_create",
      "task_update",
      "chat_agent",
      "project_publish",
    ]);
  });

  test("writes only project-management Markdown under .swarm-hive", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-file-write-"));
    try {
      const write = tools({ workspaceRoot: root })
        .find((item) => item.name === "project_file_write");
      expect(write).toBeTruthy();
      await write!.invoke({
        path: ".swarm-hive/progress.md",
        content: "# 项目进度\n",
      });
      await expect(readFile(join(root, ".swarm-hive/progress.md"), "utf8"))
        .resolves.toBe("# 项目进度\n");
      await expect(write!.invoke({ path: "src/notes.md", content: "no" }))
        .rejects.toThrow("must be Markdown under .swarm-hive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds and releases Project Agent Seats through Coordinator callbacks", async () => {
    const bindAgent = vi.fn(async ({ specKey, responsibility }) => ({
      projectId,
      seatId: targetSeatId,
      responsibility,
      isCoordinator: false,
      workspaceKey: `seat:${targetSeatId}`,
      agentInstance: {
        id: "77777777-7777-4777-8777-777777777777",
        specKey,
        specVersion: 1,
        instanceKey: "default",
        status: "active" as const,
      },
      session: {
        id: "88888888-8888-4888-8888-888888888888",
        threadId: `agent-seat:${targetSeatId}`,
        status: "active" as const,
      },
      currentRun: null,
    }));
    const releaseAgent = vi.fn(async ({ seatId, reason }) => ({
      seatId,
      status: "released" as const,
      reason,
    }));
    const projectTools = tools({ bindAgent, releaseAgent });
    await projectTools.find((item) => item.name === "project_agent_bind")!.invoke({
      spec_key: "software-engineer",
      responsibility: "完成后端实现",
    });
    await projectTools.find((item) => item.name === "project_agent_release")!.invoke({
      seat_id: targetSeatId,
      reason: "任务已经完成",
    });
    expect(bindAgent).toHaveBeenCalledWith({
      specKey: "software-engineer",
      responsibility: "完成后端实现",
    });
    expect(releaseAgent).toHaveBeenCalledWith({
      seatId: targetSeatId,
      reason: "任务已经完成",
    });
  });

  test("binds an Agent with an empty responsibility by default", async () => {
    const bindAgent = vi.fn(async ({ specKey, responsibility }) => ({
      projectId,
      seatId: targetSeatId,
      responsibility,
      isCoordinator: false,
      workspaceKey: `seat:${targetSeatId}`,
      agentInstance: {
        id: "77777777-7777-4777-8777-777777777777",
        specKey,
        specVersion: 1,
        instanceKey: "default",
        status: "active" as const,
      },
      session: {
        id: "88888888-8888-4888-8888-888888888888",
        threadId: `agent-seat:${targetSeatId}`,
        status: "active" as const,
      },
      currentRun: null,
    }));
    await tools({ bindAgent })
      .find((item) => item.name === "project_agent_bind")!
      .invoke({ spec_key: "software-engineer" });
    expect(bindAgent).toHaveBeenCalledWith({
      specKey: "software-engineer",
      responsibility: "",
    });
  });

  test("assigning a created Task activates the target Agent through the framework", async () => {
    const createTask = vi.fn(async () => task());
    const onTaskAssigned = vi.fn(async () => undefined);
    const create = tools({ repository: { createTask }, onTaskAssigned })
      .find((item) => item.name === "task_create");
    if (!create) throw new Error("task_create missing");

    await create.invoke({
      title: "实现查询接口",
      acceptance_criteria: "测试通过",
      assignee_seat_id: targetSeatId,
    });

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      assigneeSeatId: targetSeatId,
    }));
    expect(onTaskAssigned).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }));
  });

  test("reassigning a running Task activates its existing Agent", async () => {
    const before = task({ status: "running" });
    const after = task({ status: "assigned" });
    const getTask = vi.fn(async () => before);
    const updateTask = vi.fn(async () => after);
    const onTaskAssigned = vi.fn(async () => undefined);
    const update = tools({
      repository: { getTask, updateTask },
      onTaskAssigned,
    }).find((item) => item.name === "task_update");
    if (!update) throw new Error("task_update missing");

    await update.invoke({ task_id: taskId, status: "assigned" });

    expect(onTaskAssigned).toHaveBeenCalledWith(after);
  });

  test("explicitly reassigning a stuck assigned Task activates its Agent", async () => {
    const assigned = task({ status: "assigned" });
    const onTaskAssigned = vi.fn(async () => undefined);
    const update = tools({
      repository: {
        getTask: vi.fn(async () => assigned),
        updateTask: vi.fn(async () => assigned),
      },
      onTaskAssigned,
    }).find((item) => item.name === "task_update");
    if (!update) throw new Error("task_update missing");

    await update.invoke({ task_id: taskId, status: "assigned" });

    expect(onTaskAssigned).toHaveBeenCalledWith(assigned);
  });

  test("chat_agent sends an asynchronous project message without changing Task state", async () => {
    const sendAgentMessage = vi.fn(async () => ({ runId, status: "notified" as const }));
    const chat = tools({ sendAgentMessage }).find((item) => item.name === "chat_agent");
    if (!chat) throw new Error("chat_agent missing");

    await chat.invoke({ target_seat_id: targetSeatId, message: "请确认字段来源", task_id: taskId });

    expect(sendAgentMessage).toHaveBeenCalledWith({
      targetAgentSeatId: targetSeatId,
      message: "请确认字段来源",
      taskId,
    });
  });

  test("project_publish snapshots a reviewed project file", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-publish-"));
    try {
      await mkdir(join(root, ".swarm-hive"));
      await writeFile(join(root, ".swarm-hive", "pending-questions.md"), "# 待确认点\n");
      const savePublication = vi.fn(async (input) => ({
        id: "66666666-6666-4666-8666-666666666666",
        projectId,
        agentSeatId,
        runId,
        taskId: null,
        kind: input.kind,
        summary: input.summary,
        relativePath: input.relativePath,
        sha256: input.sha256,
        version: 1,
        createdAt: "2026-08-26T00:00:00.000Z",
      }));
      const onPublished = vi.fn(async () => undefined);
      const publish = tools({
        workspaceRoot: root,
        repository: { savePublication },
        onPublished,
      }).find((item) => item.name === "project_publish");
      if (!publish) throw new Error("project_publish missing");

      await publish.invoke({
        kind: "questions",
        path: ".swarm-hive/pending-questions.md",
        summary: "一个待确认点",
      });

      expect(savePublication).toHaveBeenCalledWith(expect.objectContaining({
        relativePath: join(".swarm-hive", "pending-questions.md"),
        kind: "questions",
      }));
      expect(onPublished).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
