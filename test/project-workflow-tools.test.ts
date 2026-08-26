import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { ProjectConfirmation } from "../src/contracts/workflow.js";
import type { PostgresWorkflowCoordinationRepository } from "../src/persistence/workflow-coordination-repository.js";
import { createProjectWorkflowTools } from "../src/tools/project-workflow.js";

function confirmation(): ProjectConfirmation {
  return {
    id: "confirmation-id",
    key: "design_approval",
    phase: "solution_design",
    question: "技术方案是否通过？",
    options: [],
    blockingScope: "current_phase",
    status: "open",
    artifactUrl: "https://example.feishu.cn/docx/design",
    artifactRevision: 1,
    answer: null,
    answerSource: null,
    evidence: {},
    createdAt: "2026-08-23T08:00:00Z",
    updatedAt: "2026-08-23T08:00:00Z",
    resolvedAt: null,
  };
}

describe("project workflow tools", () => {
  const eventInteractions = () => ({
    reply: vi.fn(),
    defer: vi.fn(),
  });

  test("maintains a generic resource subscription for a confirmation artifact", async () => {
    const repository = {
      upsertConfirmation: vi.fn(async () => confirmation()),
      cancelConfirmation: vi.fn(async () => ({ ...confirmation(), status: "cancelled" })),
    } as unknown as PostgresWorkflowCoordinationRepository;
    const artifactEvents = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    const tools = createProjectWorkflowTools({
      repository,
      eventInteractions: eventInteractions(),
      projectId: "project-id",
      agentForkId: "agent-id",
      runId: "run-id",
      projectRoot: "/tmp/project",
      artifactEvents,
    });
    const create = tools.find((candidate) => candidate.name === "confirmation_create");
    const cancel = tools.find((candidate) => candidate.name === "confirmation_cancel");
    if (!create || !cancel) throw new Error("confirmation tools missing");

    await create.invoke({
      key: "design_approval",
      phase: "solution_design",
      question: "技术方案是否通过？",
      blocking_scope: "current_phase",
      artifact_url: "https://example.feishu.cn/docx/design",
    });
    expect(artifactEvents.subscribe).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-id",
      confirmationKey: "design_approval",
      artifactUrl: "https://example.feishu.cn/docx/design",
    }));

    await cancel.invoke({ key: "design_approval", reason: "方案作废" });
    expect(artifactEvents.unsubscribe).toHaveBeenCalledWith({
      projectId: "project-id",
      confirmationKey: "design_approval",
    });
  });

  test("publishes an immutable Markdown report with durable project state", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "swarm-hive-report-"));
    const saveReport = vi.fn(async (input) => ({
      id: "report-id",
      reportType: input.reportType,
      phase: input.phase,
      version: input.version,
      status: input.status,
      conclusion: input.conclusion,
      relativePath: input.relativePath,
      sha256: input.sha256,
      metadata: input.metadata ?? {},
      createdAt: "2026-08-23T08:00:00Z",
    }));
    const repository = {
      listConfirmations: vi.fn(async () => [confirmation()]),
      listDeferredItems: vi.fn(async () => []),
      nextReportVersion: vi.fn(async () => 1),
      saveReport,
    } as unknown as PostgresWorkflowCoordinationRepository;
    try {
      const tools = createProjectWorkflowTools({
        repository,
        eventInteractions: eventInteractions(),
        projectId: "project-id",
        agentForkId: "agent-id",
        runId: "run-id",
        projectRoot,
      });
      const publish = tools.find((candidate) => candidate.name === "report_publish");
      if (!publish) throw new Error("report_publish missing");
      const result = await publish.invoke({
        report_type: "phase_summary",
        phase: "solution_design",
        status: "waiting_confirmation",
        conclusion: "方案已完成，等待确认。",
        completed: ["读取需求", "编写方案"],
        validation: ["原需求链接未覆盖"],
        next_action: "确认后进入开发",
        artifacts: [{
          type: "technical_design",
          label: "技术方案",
          url: "https://example.feishu.cn/docx/design",
        }],
      });
      const parsed = JSON.parse(String(result)) as { path: string; version: number };
      expect(parsed).toMatchObject({
        path: ".swarm-hive/reports/solution_design/0001.md",
        version: 1,
      });
      const markdown = await readFile(join(projectRoot, parsed.path), "utf8");
      expect(markdown).toContain("# 阶段汇报：solution_design");
      expect(markdown).toContain("技术方案是否通过？");
      expect(markdown).toContain("原需求链接未覆盖");
      expect(saveReport).toHaveBeenCalledOnce();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects a completed phase report while a current-phase confirmation is open", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "swarm-hive-report-"));
    const repository = {
      listConfirmations: vi.fn(async () => [confirmation()]),
      listDeferredItems: vi.fn(async () => []),
    } as unknown as PostgresWorkflowCoordinationRepository;
    try {
      const publish = createProjectWorkflowTools({
        repository,
        eventInteractions: eventInteractions(),
        projectId: "project-id",
        agentForkId: "agent-id",
        runId: "run-id",
        projectRoot,
      }).find((candidate) => candidate.name === "report_publish");
      if (!publish) throw new Error("report_publish missing");
      await expect(publish.invoke({
        report_type: "phase_summary",
        phase: "solution_design",
        status: "completed",
        conclusion: "完成",
        completed: [],
        validation: [],
        next_action: "进入开发",
      })).rejects.toThrow("unresolved current-phase confirmation");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("routes simple replies and deferrals through the event coordinator", async () => {
    const interactions = {
      reply: vi.fn(async () => ({
        id: "reply-interaction",
        inboxEventId: "11111111-1111-4111-8111-111111111111",
        action: "reply" as const,
        status: "sent" as const,
        content: "已确认，可以开始。",
        providerReplyId: "reply-id",
        errorMessage: null,
      })),
      defer: vi.fn(async () => ({
        id: "defer-interaction",
        inboxEventId: "22222222-2222-4222-8222-222222222222",
        action: "defer" as const,
        status: "deferred" as const,
        content: "需要读取完整文档",
        providerReplyId: null,
        errorMessage: null,
      })),
    };
    const upsertDeferredItem = vi.fn(async (input) => input);
    const appendRunEvent = vi.fn();
    const tools = createProjectWorkflowTools({
      repository: { upsertDeferredItem } as unknown as PostgresWorkflowCoordinationRepository,
      eventInteractions: interactions,
      projectId: "project-id",
      agentForkId: "agent-id",
      runId: "run-id",
      projectRoot: "/tmp/project",
      appendRunEvent,
    });
    const reply = tools.find((candidate) => candidate.name === "event_reply");
    const defer = tools.find((candidate) => candidate.name === "event_defer");
    if (!reply || !defer) throw new Error("event interaction tools missing");

    await reply.invoke({
      inbox_event_id: "11111111-1111-4111-8111-111111111111",
      content: "已确认，可以开始。",
    });
    await defer.invoke({
      inbox_event_id: "22222222-2222-4222-8222-222222222222",
      reason: "需要读取完整文档",
    });

    expect(interactions.reply).toHaveBeenCalledWith({
      projectId: "project-id",
      agentForkId: "agent-id",
      runId: "run-id",
      inboxEventId: "11111111-1111-4111-8111-111111111111",
      content: "已确认，可以开始。",
    });
    expect(interactions.defer).toHaveBeenCalledWith(expect.objectContaining({
      inboxEventId: "22222222-2222-4222-8222-222222222222",
      reason: "需要读取完整文档",
    }));
    expect(upsertDeferredItem).toHaveBeenCalledWith(expect.objectContaining({
      key: "external_event_22222222222242228222222222222222",
      phase: "external_feedback",
      reportPolicy: "phase_end",
      evidence: expect.objectContaining({
        inbox_event_id: "22222222-2222-4222-8222-222222222222",
      }),
    }));
    expect(appendRunEvent).toHaveBeenCalledTimes(2);
  });
});
