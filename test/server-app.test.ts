import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { WorkbenchQueries } from "../src/application/workbench-query-service.js";
import type { ProjectWorkflow } from "../src/application/project-workflow-service.js";
import { NotFoundError } from "../src/application/errors.js";
import type { AgentInstanceDetail, AgentSpecSummary, ProjectWorkbench, RunDetail } from "../src/contracts/workbench.js";
import { createApp } from "../src/server/app.js";

const projectId = randomUUID();
const runId = randomUUID();
const seatId = randomUUID();
const agentInstanceId = randomUUID();
const softwareEngineerSpec: AgentSpecSummary = {
  id: "software-engineer",
  name: "Software Engineer",
  version: 1,
  defaultResponsibility: "代码开发与交付",
  memory: "memory.txt",
  sandbox: { dockerfile: "sandbox/Dockerfile", image: "swarm-hive:latest" },
  environmentExample: ".env.example",
};
const workbenchResponse: ProjectWorkbench = {
  project: {
    id: projectId,
    source: "feishu",
    externalProjectId: "PROJ-1",
    name: "Example",
    status: "active",
    owner: "研发组",
    updatedAt: "2026-08-20T12:00:00.000Z",
  },
  statistics: { activeRuns: 1, totalRuns: 1, completedRuns: 0, successRate: null },
  coordinatorSeat: null,
  currentRun: null,
  recentRuns: [],
  latestInboxEvent: null,
  runtime: { status: "unknown", name: "sandbox", latencyMs: null },
};

function queries(overrides: Partial<WorkbenchQueries> = {}): WorkbenchQueries {
  return {
    ping: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
    listProjectRuns: vi.fn(async () => ({ items: [], nextCursor: null })),
    listInboxEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    listRuns: vi.fn(async () => ({ items: [], nextCursor: null })),
    listAllInboxEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    getAgentSpecUsage: vi.fn(async () => ({
      statistics: { instances: 0, activeSeats: 0, runningSeats: 0 },
      activeSeats: [],
    })),
    listAgentInstancesBySpec: vi.fn(async () => []),
    getProjectWorkbench: vi.fn(async () => workbenchResponse),
    getAgentInstance: vi.fn(async (): Promise<AgentInstanceDetail> => ({
      agentInstance: {
        id: randomUUID(),
        specKey: "software-engineer",
        specVersion: 1,
        instanceKey: "default",
        status: "active",
        homeKey: "software-engineer:default",
        lastActiveAt: null,
        createdAt: "2026-08-20T12:00:00.000Z",
      },
      seats: [],
      tasks: [],
      recentRuns: [],
    })),
    getAgentSeat: vi.fn(async (): Promise<AgentInstanceDetail> => ({
      agentInstance: {
        id: randomUUID(),
        specKey: "software-engineer",
        specVersion: 1,
        instanceKey: "default",
        status: "active",
        homeKey: "software-engineer:default",
        lastActiveAt: null,
        createdAt: "2026-08-20T12:00:00.000Z",
      },
      seats: [],
      tasks: [],
      recentRuns: [],
    })),
    getAgentConversation: vi.fn(async () => ({
      threadId: "thread",
      checkpointId: null,
      messages: [],
    })),
    getRun: vi.fn(async (): Promise<RunDetail> => ({
      id: runId,
      projectId,
      agentInstanceId: randomUUID(),
      status: "running",
      taskSummary: "Task",
      resultSummary: null,
      mergeRequestUrl: null,
      error: null,
      trigger: null,
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-08-20T12:00:00.000Z",
      updatedAt: "2026-08-20T12:00:00.000Z",
    })),
    getRunEvents: vi.fn(async () => ({ items: [], lastSequence: 0 })),
    ...overrides,
  };
}

describe("Hono server app", () => {
  const specCatalog = {
    list: vi.fn(async () => ({ items: [] })),
    get: vi.fn(async () => null),
  };
  test("serves liveness and readiness checks", async () => {
    const app = createApp({ workbench: queries(), specCatalog, enableRequestLogger: false });
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
  });

  test("returns 503 when the database is not ready", async () => {
    const app = createApp({
      workbench: queries({ ping: vi.fn(async () => Promise.reject(new Error("down"))) }),
      specCatalog,
      enableRequestLogger: false,
    });
    expect((await app.request("/readyz")).status).toBe(503);
  });

  test("validates and serves the workbench route", async () => {
    const getProjectWorkbench = vi.fn(async () => workbenchResponse);
    const app = createApp({
      workbench: queries({ getProjectWorkbench }),
      specCatalog,
      enableRequestLogger: false,
    });
    const response = await app.request(`/api/v1/projects/${projectId}/workbench`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ project: { id: projectId } });
    expect(getProjectWorkbench).toHaveBeenCalledWith(projectId);
    expect((await app.request("/api/v1/projects/not-a-uuid/workbench")).status).toBe(400);
  });

  test("maps application errors and validates event pagination", async () => {
    const app = createApp({
      workbench: queries({
        getProjectWorkbench: vi.fn(async () => Promise.reject(new NotFoundError("Project"))),
      }),
      specCatalog,
      enableRequestLogger: false,
    });
    expect((await app.request(`/api/v1/projects/${projectId}/workbench`)).status).toBe(404);
    expect((await app.request(`/api/v1/runs/${runId}/events?limit=0`)).status).toBe(400);
  });

  test("serves the read-only Project tabs", async () => {
    const listProjectRuns = vi.fn(async () => ({ items: [], nextCursor: null }));
    const listInboxEvents = vi.fn(async () => ({ items: [], nextCursor: null }));
    const app = createApp({
      workbench: queries({ listProjectRuns, listInboxEvents }),
      specCatalog,
      enableRequestLogger: false,
    });
    expect((await app.request(`/api/v1/projects/${projectId}/runs?limit=25`)).status).toBe(200);
    expect((await app.request(`/api/v1/projects/${projectId}/inbox-events?limit=25`)).status).toBe(200);
    expect(listProjectRuns).toHaveBeenCalledWith(projectId, { limit: 25 });
    expect(listInboxEvents).toHaveBeenCalledWith(projectId, { limit: 25 });
  });

  test("serves the global read-only navigation", async () => {
    const app = createApp({ workbench: queries(), specCatalog, enableRequestLogger: false });
    expect((await app.request("/api/v1/runs?limit=25")).status).toBe(200);
    expect((await app.request("/api/v1/inbox-events?limit=25")).status).toBe(200);
    expect((await app.request("/api/v1/agent-specs")).status).toBe(200);
  });

  test("serves SPA routes while preserving JSON API 404 responses", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "swarm-hive-static-"));
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>SwarmHive</title>");
    try {
      const app = createApp({
        workbench: queries(),
        specCatalog,
        staticRoot,
        enableRequestLogger: false,
      });
      const pageResponse = await app.request(
        `/projects/${projectId}/agent-seats/${seatId}`,
      );
      expect(pageResponse.status).toBe(200);
      expect(pageResponse.headers.get("content-type")).toContain("text/html");
      expect(await pageResponse.text()).toContain("SwarmHive");

      const apiResponse = await app.request("/api/v1/does-not-exist");
      expect(apiResponse.status).toBe(404);
      expect(apiResponse.headers.get("content-type")).toContain("application/json");
      expect(await apiResponse.json()).toMatchObject({
        error: { code: "not_found" },
      });
    } finally {
      await rm(staticRoot, { recursive: true, force: true });
    }
  });

  test("serves and validates the Agent Instance detail route", async () => {
    const getAgentInstance = vi.fn(async (): Promise<AgentInstanceDetail> => ({
      agentInstance: {
        id: agentInstanceId,
        specKey: "software-engineer",
        specVersion: 1,
        instanceKey: "default",
        status: "active",
        homeKey: "software-engineer:default",
        lastActiveAt: null,
        createdAt: "2026-08-20T12:00:00.000Z",
      },
      seats: [],
      tasks: [],
      recentRuns: [],
    }));
    const app = createApp({
      workbench: queries({ getAgentInstance }),
      specCatalog,
      enableRequestLogger: false,
    });
    const response = await app.request(`/api/v1/agent-instances/${agentInstanceId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agentInstance: { id: agentInstanceId } });
    expect(getAgentInstance).toHaveBeenCalledWith(agentInstanceId);
    expect((await app.request("/api/v1/agent-instances/not-a-uuid")).status).toBe(400);
  });

  test("serves and validates the Agent Seat detail route", async () => {
    const getAgentSeat = vi.fn(async (): Promise<AgentInstanceDetail> => ({
      agentInstance: {
        id: agentInstanceId,
        specKey: "software-engineer",
        specVersion: 1,
        instanceKey: "default",
        status: "active",
        homeKey: "software-engineer:default",
        lastActiveAt: null,
        createdAt: "2026-08-20T12:00:00.000Z",
      },
      seats: [],
      tasks: [],
      recentRuns: [],
    }));
    const app = createApp({
      workbench: queries({ getAgentSeat }),
      specCatalog,
      enableRequestLogger: false,
    });
    const response = await app.request(`/api/v1/agent-seats/${seatId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agentInstance: { id: agentInstanceId } });
    expect(getAgentSeat).toHaveBeenCalledWith(seatId);
    expect((await app.request("/api/v1/agent-seats/not-a-uuid")).status).toBe(400);
  });

  test("serves an Agent Instance conversation", async () => {
    const getAgentConversation = vi.fn(async () => ({
      threadId: "thread",
      checkpointId: "checkpoint-1",
      messages: [{
        id: "message-1",
        role: "ai" as const,
        name: "coding-agent",
        content: "正在检查代码",
        toolCallId: null,
        toolCalls: [],
        status: null,
      }],
    }));
    const app = createApp({
      workbench: queries({ getAgentConversation }),
      specCatalog,
      enableRequestLogger: false,
    });
    const response = await app.request(`/api/v1/agent-sessions/${agentInstanceId}/conversation`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messages: [{ content: "正在检查代码" }] });
    expect(getAgentConversation).toHaveBeenCalledWith(agentInstanceId);
  });

  test("serves an Agent Spec with each active Seat", async () => {
    const getAgentSpecUsage = vi.fn(async () => ({
      statistics: { instances: 2, activeSeats: 2, runningSeats: 1 },
      activeSeats: [],
    }));
    const app = createApp({
      workbench: queries({
        getAgentSpecUsage,
        listAgentInstancesBySpec: vi.fn(async () => []),
      }),
      specCatalog: {
        list: vi.fn(async () => ({ items: [softwareEngineerSpec] })),
        get: vi.fn(async (key: string) => key === softwareEngineerSpec.id ? softwareEngineerSpec : null),
        getDefinition: vi.fn(async () => ({ prompt: "Build software.", memory: "Use uv." })),
      },
      enableRequestLogger: false,
    });
    const response = await app.request("/api/v1/agent-specs/software-engineer");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      spec: { id: "software-engineer" },
      statistics: { instances: 2, activeSeats: 2 },
      definition: { prompt: "Build software.", memory: "Use uv." },
      instances: [],
    });
    expect(getAgentSpecUsage).toHaveBeenCalledWith("software-engineer");
    expect((await app.request("/api/v1/agent-specs/unknown")).status).toBe(404);
    expect((await app.request("/api/v1/agent-specs/invalid%20key")).status).toBe(400);
  });

  test("previews a live Feishu requirement and starts an assigned Agent", async () => {
    const preview = vi.fn(async () => ({
      sourceUrl: "https://project.feishu.cn/example-project/story/detail/1234567890",
      projectKey: "space-key",
      project: { key: "space-key", simpleName: "example-project", name: "研发空间" },
      workItemId: "1234567890",
      workItemType: { key: "story", name: "需求" },
      title: "实时需求",
      status: { key: "developing", name: "开发中" },
      roles: [],
      currentNodes: [],
      fields: [],
      updatedAt: null,
      seats: [],
    }));
    const assignSeat = vi.fn(async () => ({
      projectId,
      seatId,
      responsibility: "backend-a",
      isCoordinator: true,
      workspaceKey: "seat:seat-id",
      agentInstance: {
        id: randomUUID(),
        specKey: "software-engineer",
        specVersion: 1,
        instanceKey: "default",
        status: "active" as const,
      },
      session: {
        id: randomUUID(),
        threadId: "thread",
        status: "active" as const,
      },
      currentRun: null,
    }));
    const start = vi.fn(async () => ({
      runId,
      projectId,
      agentInstanceId: randomUUID(),
      seatId,
      sessionId: randomUUID(),
      status: "queued" as const,
    }));
    const cancel = vi.fn(async () => ({
      runId,
      agentInstanceId,
      status: "cancelled" as const,
    }));
    const resume = vi.fn(async () => ({ runId, status: "running" as const }));
    const message = vi.fn(async () => ({ projectId, runId, status: "notified" as const }));
    const projectWorkflow: ProjectWorkflow = { preview, assignSeat, start, resume, cancel, message };
    const app = createApp({
      workbench: queries(),
      specCatalog,
      projectWorkflow,
      enableRequestLogger: false,
    });
    const sourceUrl = "https://project.feishu.cn/example-project/story/detail/1234567890";
    const previewResponse = await app.request("/api/v1/feishu-project/work-items/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: sourceUrl }),
    });
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({ title: "实时需求" });
    expect(preview).toHaveBeenCalledWith(sourceUrl);

    const assignmentResponse = await app.request("/api/v1/agent-seats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: sourceUrl,
        specKey: "software-engineer",
        responsibility: "backend-a",
      }),
    });
    expect(assignmentResponse.status).toBe(201);
    expect(await assignmentResponse.json()).toMatchObject({ seatId });
    expect(assignSeat).toHaveBeenCalledOnce();

    const blankResponsibilityResponse = await app.request("/api/v1/agent-seats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: sourceUrl, specKey: "software-engineer" }),
    });
    expect(blankResponsibilityResponse.status).toBe(201);
    expect(assignSeat).toHaveBeenLastCalledWith({
      url: sourceUrl,
      specKey: "software-engineer",
      responsibility: "",
    });

    const runResponse = await app.request(`/api/v1/agent-seats/${seatId}/runs`, {
      method: "POST",
    });
    expect(runResponse.status).toBe(202);
    expect(await runResponse.json()).toMatchObject({ runId, status: "queued" });
    expect(start).toHaveBeenCalledWith(seatId);

    const cancelResponse = await app.request(`/api/v1/runs/${runId}/cancel`, {
      method: "POST",
    });
    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toMatchObject({ runId, status: "cancelled" });
    expect(cancel).toHaveBeenCalledWith(runId);

    const resumeResponse = await app.request(`/api/v1/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "通过方案",
      }),
    });
    expect(resumeResponse.status).toBe(202);
    expect(await resumeResponse.json()).toMatchObject({ runId, status: "running" });
    expect(resume).toHaveBeenCalledWith(runId, {
      message: "通过方案",
    });

    const messageResponse = await app.request(`/api/v1/projects/${projectId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "请汇报当前项目状态" }),
    });
    expect(messageResponse.status).toBe(202);
    expect(await messageResponse.json()).toMatchObject({ projectId, runId, status: "notified" });
    expect(message).toHaveBeenCalledWith(projectId, { message: "请汇报当前项目状态" });

    const legacyResumeResponse = await app.request(`/api/v1/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answers: { "solution-design-approval": { answers: ["通过方案"] } },
      }),
    });
    expect(legacyResumeResponse.status).toBe(400);
  });
});
