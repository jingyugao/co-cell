import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { tool } from "langchain";
import { z } from "zod";

import type { PostgresWorkflowCoordinationRepository } from "../persistence/workflow-coordination-repository.js";
import type { PostgresProjectEventInteractions } from "../events/project-event-interactions.js";
import { redactSensitiveText } from "../security/redact.js";

const KeySchema = z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/);
const PhaseSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/);
const EvidenceSchema = z.record(z.string(), z.unknown()).optional();

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function markdownList(values: readonly string[], empty = "- 无"): string {
  return values.length > 0
    ? values.map((value) => `- ${redactSensitiveText(value)}`).join("\n")
    : empty;
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "report";
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export interface ProjectWorkflowToolOptions {
  repository: PostgresWorkflowCoordinationRepository;
  eventInteractions: Pick<PostgresProjectEventInteractions, "reply" | "defer">;
  projectId: string;
  agentForkId: string;
  runId: string;
  projectRoot: string;
  artifactEvents?: {
    subscribe(input: {
      projectId: string;
      confirmationId: string;
      confirmationKey: string;
      artifactUrl: string;
    }): Promise<void>;
    unsubscribe(input: {
      projectId: string;
      confirmationKey: string;
    }): Promise<void>;
  };
  appendRunEvent?: (input: {
    eventType: string;
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
  }) => Promise<void>;
}

export function createProjectWorkflowTools(options: ProjectWorkflowToolOptions) {
  const eventReply = tool(async (input) => {
    const interaction = await options.eventInteractions.reply({
      projectId: options.projectId,
      agentForkId: options.agentForkId,
      runId: options.runId,
      inboxEventId: input.inbox_event_id,
      content: input.content,
    });
    await options.appendRunEvent?.({
      eventType: "external_event_replied",
      title: "Agent 回复外部反馈",
      detail: input.content,
      data: { inboxEventId: input.inbox_event_id, interactionId: interaction.id },
    });
    return json(interaction);
  }, {
    name: "event_reply",
    description:
      "Reply to a simple external question using its Inbox Event ID. The event system " +
      "routes the reply to the original provider and prevents duplicate replies. Do not " +
      "use provider-specific tools for simple event replies.",
    schema: z.object({
      inbox_event_id: z.string().uuid(),
      content: z.string().trim().min(1).max(4_000),
    }),
  });

  const eventDefer = tool(async (input) => {
    const interaction = await options.eventInteractions.defer({
      projectId: options.projectId,
      agentForkId: options.agentForkId,
      runId: options.runId,
      inboxEventId: input.inbox_event_id,
      reason: input.reason,
    });
    await options.repository.upsertDeferredItem({
      projectId: options.projectId,
      agentForkId: options.agentForkId,
      runId: options.runId,
      key: `external_event_${input.inbox_event_id.replaceAll("-", "")}`,
      phase: "external_feedback",
      title: "外部反馈需进一步处理",
      detail: input.reason,
      reportPolicy: "phase_end",
      evidence: {
        inbox_event_id: input.inbox_event_id,
        interaction_id: interaction.id,
      },
    });
    await options.appendRunEvent?.({
      eventType: "external_event_deferred",
      title: "Agent 暂缓外部反馈",
      detail: input.reason,
      data: { inboxEventId: input.inbox_event_id, interactionId: interaction.id },
    });
    return json(interaction);
  }, {
    name: "event_defer",
    description:
      "Defer an external question only after the Agent has used the available provider " +
      "and project tools to obtain necessary context but still cannot complete it. A " +
      "durable deferred item is created for later reporting.",
    schema: z.object({
      inbox_event_id: z.string().uuid(),
      reason: z.string().trim().min(1).max(2_000),
    }),
  });

  const confirmationCreate = tool(async (input) => {
    const confirmation = await options.repository.upsertConfirmation({
      projectId: options.projectId,
      agentForkId: options.agentForkId,
      runId: options.runId,
      key: input.key,
      phase: input.phase,
      question: input.question,
      options: input.options ?? [],
      blockingScope: input.blocking_scope,
      ...(input.artifact_url ? { artifactUrl: input.artifact_url } : {}),
      ...(input.artifact_revision ? { artifactRevision: input.artifact_revision } : {}),
    });
    if (confirmation.artifactUrl) {
      await options.artifactEvents?.subscribe({
        projectId: options.projectId,
        confirmationId: confirmation.id,
        confirmationKey: confirmation.key,
        artifactUrl: confirmation.artifactUrl,
      });
    }
    await options.appendRunEvent?.({
      eventType: "confirmation_created",
      title: "Agent 新增待确认事项",
      detail: confirmation.question,
      data: { confirmationId: confirmation.id, key: confirmation.key },
    });
    return json(confirmation);
  }, {
    name: "confirmation_create",
    description:
      "Create or update a durable question that requires external confirmation. " +
      "This does not block the current model call. Use current_phase only when the " +
      "answer is required before moving to the next workflow phase.",
    schema: z.object({
      key: KeySchema.describe("Stable project-wide confirmation key."),
      phase: PhaseSchema,
      question: z.string().trim().min(1).max(2_000),
      options: z.array(z.object({
        label: z.string().trim().min(1).max(100),
        description: z.string().trim().min(1).max(500),
      })).max(3).optional(),
      blocking_scope: z.enum(["current_phase", "future_phase", "non_blocking", "final_only"]),
      artifact_url: z.string().url().optional(),
      artifact_revision: z.number().int().positive().optional(),
    }),
  });

  const confirmationList = tool(async (input) => {
    return json(await options.repository.listConfirmations({
      projectId: options.projectId,
      ...(input.statuses?.length ? { statuses: input.statuses } : {}),
    }));
  }, {
    name: "confirmation_list",
    description:
      "List durable project confirmation points. Always call this before starting a " +
      "new workflow phase so unresolved blocking decisions are not skipped.",
    schema: z.object({
      statuses: z.array(z.enum(["open", "answer_received", "resolved", "cancelled"]))
        .optional(),
    }),
  });

  const confirmationResolve = tool(async (input) => {
    const confirmation = await options.repository.resolveConfirmation({
      projectId: options.projectId,
      key: input.key,
      answer: input.answer,
      source: "agent",
      ...(input.evidence ? { evidence: input.evidence } : {}),
    });
    if (!confirmation) throw new Error(`Open confirmation was not found: ${input.key}`);
    await options.appendRunEvent?.({
      eventType: "confirmation_resolved",
      title: "Agent 已核验确认事项",
      detail: `${confirmation.question}：${confirmation.answer ?? "已解决"}`,
      data: { confirmationId: confirmation.id, key: confirmation.key },
    });
    return json(confirmation);
  }, {
    name: "confirmation_resolve",
    description:
      "Resolve a confirmation only after the Agent has interpreted a clear human or " +
      "external answer. Include comment/event evidence when available.",
    schema: z.object({
      key: KeySchema,
      answer: z.string().trim().min(1).max(4_000),
      evidence: EvidenceSchema,
    }),
  });

  const confirmationCancel = tool(async (input) => {
    const confirmation = await options.repository.cancelConfirmation({
      projectId: options.projectId,
      key: input.key,
      reason: input.reason,
    });
    if (!confirmation) throw new Error(`Open confirmation was not found: ${input.key}`);
    await options.artifactEvents?.unsubscribe({
      projectId: options.projectId,
      confirmationKey: confirmation.key,
    });
    return json(confirmation);
  }, {
    name: "confirmation_cancel",
    description: "Cancel a confirmation that is proven obsolete or duplicated.",
    schema: z.object({
      key: KeySchema,
      reason: z.string().trim().min(1).max(2_000),
    }),
  });

  const deferredCreate = tool(async (input) => {
    return json(await options.repository.upsertDeferredItem({
      projectId: options.projectId,
      agentForkId: options.agentForkId,
      runId: options.runId,
      key: input.key,
      phase: input.phase,
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      reportPolicy: input.report_policy,
      ...(input.evidence ? { evidence: input.evidence } : {}),
    }));
  }, {
    name: "deferred_item_create",
    description:
      "Record a non-blocking observation or follow-up that should be reported later " +
      "instead of interrupting the user now. Do not use this for required decisions.",
    schema: z.object({
      key: KeySchema,
      phase: PhaseSchema,
      title: z.string().trim().min(1).max(500),
      detail: z.string().trim().max(4_000).optional(),
      report_policy: z.enum(["phase_end", "final_only"]),
      evidence: EvidenceSchema,
    }),
  });

  const deferredList = tool(async (input) => {
    return json(await options.repository.listDeferredItems({
      projectId: options.projectId,
      ...(input.statuses?.length ? { statuses: input.statuses } : {}),
    }));
  }, {
    name: "deferred_item_list",
    description: "List deferred non-blocking project items for phase or final reporting.",
    schema: z.object({
      statuses: z.array(z.enum(["open", "completed", "cancelled"])).optional(),
    }),
  });

  const deferredComplete = tool(async (input) => {
    const item = await options.repository.completeDeferredItem({
      projectId: options.projectId,
      key: input.key,
      ...(input.evidence ? { evidence: input.evidence } : {}),
    });
    if (!item) throw new Error(`Open deferred item was not found: ${input.key}`);
    return json(item);
  }, {
    name: "deferred_item_complete",
    description: "Mark a deferred item completed and retain its evidence.",
    schema: z.object({ key: KeySchema, evidence: EvidenceSchema }),
  });

  const reportPublish = tool(async (input) => {
    const [confirmations, deferredItems] = await Promise.all([
      options.repository.listConfirmations({ projectId: options.projectId }),
      options.repository.listDeferredItems({ projectId: options.projectId }),
    ]);
    const blocking = confirmations.filter((item) =>
      item.blockingScope === "current_phase" &&
      (item.status === "open" || item.status === "answer_received")
    );
    if (input.status === "completed" && blocking.length > 0) {
      throw new Error(
        `Cannot publish a completed phase report with ${blocking.length} unresolved current-phase confirmation(s)`,
      );
    }
    const version = await options.repository.nextReportVersion(options.projectId, input.phase);
    const relativePath = `.swarm-hive/reports/${safeSegment(input.phase)}/${String(version).padStart(4, "0")}.md`;
    const canonicalProjectRoot = await realpath(resolve(options.projectRoot));
    const controlRoot = resolve(canonicalProjectRoot, ".swarm-hive");
    await mkdir(controlRoot, { recursive: true });
    const canonicalControlRoot = await realpath(controlRoot);
    if (!isWithin(canonicalProjectRoot, canonicalControlRoot)) {
      throw new Error("Project control directory escapes the project workspace");
    }
    const reportDirectory = resolve(
      canonicalControlRoot,
      "reports",
      safeSegment(input.phase),
    );
    await mkdir(reportDirectory, { recursive: true });
    const canonicalReportDirectory = await realpath(reportDirectory);
    if (!isWithin(canonicalControlRoot, canonicalReportDirectory)) {
      throw new Error("Report directory escapes the project control directory");
    }
    const absolutePath = resolve(
      canonicalReportDirectory,
      `${String(version).padStart(4, "0")}.md`,
    );
    const openConfirmations = confirmations.filter((item) =>
      item.status === "open" || item.status === "answer_received"
    );
    const openDeferred = deferredItems.filter((item) => item.status === "open");
    const artifactLines = (input.artifacts ?? []).map((artifact) => {
      const target = artifact.url ?? artifact.path;
      return target ? `${artifact.label}：${target}` : artifact.label;
    });
    const confirmationSections = openConfirmations.map((item) =>
      `### ${item.question}\n\n` +
      `- Key：\`${item.key}\`\n` +
      `- 状态：${item.status}\n` +
      `- 阻塞范围：${item.blockingScope}\n` +
      (item.answer ? `- 已收到候选回答：${redactSensitiveText(item.answer)}\n` : "") +
      (item.artifactUrl ? `- 关联文档：${item.artifactUrl}\n` : "")
    );
    const markdown = redactSensitiveText(
      `# 阶段汇报：${input.phase}\n\n` +
      `- 项目 ID：\`${options.projectId}\`\n` +
      `- Run ID：\`${options.runId}\`\n` +
      `- 报告类型：${input.report_type}\n` +
      `- 状态：${input.status}\n` +
      `- 报告版本：${version}\n\n` +
      `## 结论\n\n${input.conclusion}\n\n` +
      `## 已完成\n\n${markdownList(input.completed)}\n\n` +
      `## 交付物\n\n${markdownList(artifactLines)}\n\n` +
      `## 待确认事项\n\n${confirmationSections.length ? confirmationSections.join("\n") : "- 无\n"}\n` +
      `## 暂缓事项\n\n${markdownList(openDeferred.map((item) =>
        `${item.title}${item.detail ? `：${item.detail}` : ""}（${item.reportPolicy}）`
      ))}\n\n` +
      `## 验证结果\n\n${markdownList(input.validation)}\n\n` +
      `## 下一步\n\n${input.next_action}\n`,
    );
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, markdown, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, absolutePath);
    const sha256 = createHash("sha256").update(markdown).digest("hex");
    let report;
    try {
      report = await options.repository.saveReport({
        projectId: options.projectId,
        agentForkId: options.agentForkId,
        runId: options.runId,
        reportType: input.report_type,
        phase: input.phase,
        version,
        status: input.status,
        conclusion: input.conclusion,
        relativePath,
        sha256,
        metadata: {
          artifacts: input.artifacts ?? [],
          open_confirmation_keys: openConfirmations.map((item) => item.key),
          deferred_item_keys: openDeferred.map((item) => item.key),
        },
      });
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
    await options.appendRunEvent?.({
      eventType: "report_published",
      title: "Agent 发布阶段汇报",
      detail: input.conclusion,
      data: {
        reportId: report.id,
        phase: report.phase,
        version: report.version,
        path: report.relativePath,
      },
    });
    return json({
      report_id: report.id,
      version: report.version,
      path: report.relativePath,
      sha256: report.sha256,
      status: "published",
      open_confirmations: openConfirmations.map((item) => item.key),
      deferred_items: openDeferred.map((item) => item.key),
      deliveries: { control_panel: "delivered", feishu: "not_requested" },
    });
  }, {
    name: "report_publish",
    description:
      "Publish an immutable Markdown phase report under the project's persistent " +
      ".swarm-hive/reports directory. The tool automatically includes open " +
      "confirmations and deferred items and rejects completed reports when current " +
      "phase blockers remain.",
    schema: z.object({
      report_type: z.enum(["phase_summary", "blocked", "final_summary"]),
      phase: PhaseSchema,
      status: z.enum(["in_progress", "waiting_confirmation", "completed", "blocked"]),
      conclusion: z.string().trim().min(1).max(4_000),
      completed: z.array(z.string().trim().min(1).max(1_000)).max(50),
      validation: z.array(z.string().trim().min(1).max(1_000)).max(50),
      next_action: z.string().trim().min(1).max(2_000),
      artifacts: z.array(z.object({
        type: z.string().trim().min(1).max(100),
        label: z.string().trim().min(1).max(300),
        url: z.string().url().optional(),
        path: z.string().trim().min(1).max(1_000).optional(),
      }).refine((value) => Boolean(value.url || value.path), {
        message: "artifact requires url or path",
      })).max(50).optional(),
    }),
  });

  return [
    eventReply,
    eventDefer,
    confirmationCreate,
    confirmationList,
    confirmationResolve,
    confirmationCancel,
    deferredCreate,
    deferredList,
    deferredComplete,
    reportPublish,
  ];
}
