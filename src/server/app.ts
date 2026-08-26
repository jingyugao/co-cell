import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

import {
  ApplicationError,
  InvalidRequestError,
  NotFoundError,
} from "../application/errors.js";
import type { WorkbenchQueries } from "../application/workbench-query-service.js";
import type { RequirementWorkflow } from "../application/requirement-workflow-service.js";
import type { AgentSpecCatalog } from "./agent-spec-catalog.js";

export interface CreateAppOptions {
  workbench: WorkbenchQueries;
  specCatalog: AgentSpecCatalog;
  requirements?: RequirementWorkflow;
  staticRoot?: string;
  enableRequestLogger?: boolean;
}

const uuidSchema = z.string().uuid();
const specKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const projectListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
  status: z.enum(["active", "closed", "archived"]).optional(),
});
const runEventsQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const paginatedListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
const workItemPreviewSchema = z.object({
  url: z.string().url().max(2_000),
});
const assignmentSchema = z.object({
  url: z.string().url().max(2_000),
  specKey: specKeySchema,
  role: z.string().trim().min(1).max(100),
});
const resumeRunSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
});

function requirements(options: CreateAppOptions): RequirementWorkflow {
  if (!options.requirements) {
    throw new ApplicationError("Requirement workflow is not configured", "not_configured", 503);
  }
  return options.requirements;
}

function validatedId(value: string, label: string): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw new InvalidRequestError(`${label} must be a UUID`);
  return result.data;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  app.use("*", requestId());
  app.use("*", secureHeaders());
  if (options.enableRequestLogger !== false) app.use("*", logger());

  app.get("/healthz", (context) =>
    context.json({ status: "ok", requestId: context.get("requestId") }),
  );
  app.get("/readyz", async (context) => {
    try {
      await options.workbench.ping();
      return context.json({ status: "ready", requestId: context.get("requestId") });
    } catch {
      return context.json(
        { status: "not_ready", requestId: context.get("requestId") },
        503,
      );
    }
  });

  app.get("/api/v1/projects", async (context) => {
    const parsed = projectListQuerySchema.safeParse(context.req.query());
    if (!parsed.success) throw new InvalidRequestError("Invalid project list query");
    return context.json(await options.workbench.listProjects(parsed.data));
  });

  app.get("/api/v1/runs", async (context) => {
    const parsed = paginatedListQuerySchema.safeParse(context.req.query());
    if (!parsed.success) throw new InvalidRequestError("Invalid Run list query");
    return context.json(await options.workbench.listRuns(parsed.data));
  });

  app.get("/api/v1/inbox-events", async (context) => {
    const parsed = paginatedListQuerySchema.safeParse(context.req.query());
    if (!parsed.success) throw new InvalidRequestError("Invalid Inbox Event list query");
    return context.json(await options.workbench.listAllInboxEvents(parsed.data));
  });

  app.get("/api/v1/agent-specs", async (context) =>
    context.json(await options.specCatalog.list()),
  );

  app.get("/api/v1/agent-specs/:specKey", async (context) => {
    const parsed = specKeySchema.safeParse(context.req.param("specKey"));
    if (!parsed.success) throw new InvalidRequestError("specKey is invalid");
    const spec = await options.specCatalog.get(parsed.data);
    if (!spec) throw new NotFoundError("Agent Spec");
    const usage = await options.workbench.getAgentSpecUsage(parsed.data);
    return context.json({ spec, ...usage });
  });

  app.post("/api/v1/feishu-project/work-items/preview", async (context) => {
    const parsed = workItemPreviewSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new InvalidRequestError("A valid Feishu work item URL is required");
    return context.json(await requirements(options).preview(parsed.data.url));
  });

  app.post("/api/v1/agent-forks", async (context) => {
    const parsed = assignmentSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new InvalidRequestError("Agent Fork is invalid");
    return context.json(await requirements(options).fork(parsed.data), 201);
  });

  app.post("/api/v1/agent-forks/:forkId/runs", async (context) => {
    const forkId = validatedId(context.req.param("forkId"), "forkId");
    return context.json(await requirements(options).start(forkId), 202);
  });

  app.post("/api/v1/runs/:runId/cancel", async (context) => {
    const runId = validatedId(context.req.param("runId"), "runId");
    return context.json(await requirements(options).cancel(runId));
  });

  app.post("/api/v1/runs/:runId/resume", async (context) => {
    const runId = validatedId(context.req.param("runId"), "runId");
    const parsed = resumeRunSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new InvalidRequestError("A valid Agent message is required");
    return context.json(await requirements(options).resume(runId, parsed.data), 202);
  });

  app.get("/api/v1/projects/:projectId/workbench", async (context) => {
    const projectId = validatedId(context.req.param("projectId"), "projectId");
    return context.json(await options.workbench.getProjectWorkbench(projectId));
  });

  app.get("/api/v1/projects/:projectId/runs", async (context) => {
    const projectId = validatedId(context.req.param("projectId"), "projectId");
    const parsed = paginatedListQuerySchema.safeParse(context.req.query());
    if (!parsed.success) throw new InvalidRequestError("Invalid Run list query");
    return context.json(await options.workbench.listProjectRuns(projectId, parsed.data));
  });

  app.get("/api/v1/projects/:projectId/inbox-events", async (context) => {
    const projectId = validatedId(context.req.param("projectId"), "projectId");
    const parsed = paginatedListQuerySchema.safeParse(context.req.query());
    if (!parsed.success) throw new InvalidRequestError("Invalid Inbox Event list query");
    return context.json(await options.workbench.listInboxEvents(projectId, parsed.data));
  });

  app.get("/api/v1/runs/:runId/events", async (context) => {
    const runId = validatedId(context.req.param("runId"), "runId");
    const parsed = runEventsQuerySchema.safeParse(context.req.query());
    if (!parsed.success) throw new InvalidRequestError("Invalid run events query");
    return context.json(
      await options.workbench.getRunEvents(
        runId,
        parsed.data.afterSequence,
        parsed.data.limit,
      ),
    );
  });

  app.get("/api/v1/agent-instances/:agentInstanceId", async (context) => {
    const agentInstanceId = validatedId(
      context.req.param("agentInstanceId"),
      "agentInstanceId",
    );
    return context.json(await options.workbench.getAgentInstance(agentInstanceId));
  });

  app.get("/api/v1/agent-sessions/:agentSessionId/conversation", async (context) => {
    const agentSessionId = validatedId(
      context.req.param("agentSessionId"),
      "agentSessionId",
    );
    return context.json(await options.workbench.getAgentConversation(agentSessionId));
  });

  app.get("/api/v1/reports/:reportId", async (context) => {
    const reportId = validatedId(context.req.param("reportId"), "reportId");
    const report = await options.workbench.getReportMarkdown(reportId);
    context.header("content-type", "text/markdown; charset=utf-8");
    context.header("content-disposition", `inline; filename="${report.filename}"`);
    return context.body(report.content);
  });

  app.get("/api/v1/runs/:runId", async (context) => {
    const runId = validatedId(context.req.param("runId"), "runId");
    return context.json(await options.workbench.getRun(runId));
  });

  // Keep unknown API routes as JSON 404s; the HTML fallback below is only for SPA pages.
  app.all("/api/*", (context) =>
    context.json(
      {
        error: { code: "not_found", message: "Resource was not found" },
        requestId: context.get("requestId"),
      },
      404,
    ),
  );

  app.notFound((context) =>
    context.json(
      {
        error: { code: "not_found", message: "Resource was not found" },
        requestId: context.get("requestId"),
      },
      404,
    ),
  );

  app.onError((error, context) => {
    const applicationError =
      error instanceof ApplicationError
        ? error
        : new ApplicationError("Internal server error", "internal_error", 500);
    if (applicationError.status >= 500) console.error(error);
    return context.json(
      {
        error: { code: applicationError.code, message: applicationError.message },
        requestId: context.get("requestId"),
      },
      applicationError.status as 400 | 404 | 500 | 503,
    );
  });

  if (options.staticRoot && existsSync(resolve(options.staticRoot, "index.html"))) {
    app.use("/*", serveStatic({ root: options.staticRoot }));
    app.get("/*", serveStatic({ path: resolve(options.staticRoot, "index.html") }));
  }

  return app;
}
