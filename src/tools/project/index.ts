import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { tool } from "langchain";
import { z } from "zod";

import type { AgentSeatResult } from "../../contracts/projects.js";
import {
  createProjectWorkflowTools,
  type ProjectWorkflowToolOptions,
} from "../project-workflow.js";

export interface ProjectToolContext {
  project: {
    id: string;
    source: string;
    sourceUrl: string | null;
    externalProjectId: string;
    status: string;
  };
  seat: {
    id: string;
    specKey: string;
    defaultResponsibility: string;
    responsibility: string;
    effectiveResponsibility: string;
    isCoordinator: boolean;
  };
}

export interface ProjectToolsOptions extends ProjectWorkflowToolOptions {
  isCoordinator: boolean;
  listBindableAgentSpecs(): Promise<Array<{
    id: string;
    name: string;
    version: number;
    defaultResponsibility: string;
  }>>;
  getProject(): Promise<ProjectToolContext>;
  bindAgent(input: {
    specKey: string;
    responsibility: string;
  }): Promise<AgentSeatResult>;
  releaseAgent(input: {
    seatId: string;
    reason: string;
  }): Promise<{ seatId: string; status: "released"; reason: string }>;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Build the project-scoped tool set, with staffing tools reserved for the Coordinator. */
export function createProjectTools(options: ProjectToolsOptions) {
  const projectGet = tool(async () => json(await options.getProject()), {
    name: "project_get",
    description:
      "Get the current Project identity and this Agent Seat. Use the source URL with its native CLI for requirement details.",
    schema: z.object({}),
  });

  const projectFileWrite = tool(async (input) => {
    const workspaceRoot = await realpath(resolve(options.workspaceRoot));
    const file = resolve(workspaceRoot, input.path);
    const relativePath = relative(workspaceRoot, file);
    if (
      !isWithin(workspaceRoot, file) ||
      !relativePath.startsWith(`.swarm-hive${process.platform === "win32" ? "\\" : "/"}`) ||
      !relativePath.endsWith(".md")
    ) {
      throw new Error("Project files must be Markdown under .swarm-hive/");
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, input.content, "utf8");
    return json({ path: relativePath, bytes: Buffer.byteLength(input.content) });
  }, {
    name: "project_file_write",
    description:
      "Create or replace a project-management Markdown file under .swarm-hive/. Use this instead of shell commands for progress, questions and reports.",
    schema: z.object({
      path: z.string().trim().min(1).max(500),
      content: z.string().min(1).max(100_000),
    }),
  });

  const tools = [projectGet, projectFileWrite, ...createProjectWorkflowTools(options)];
  if (!options.isCoordinator) return tools;

  const projectAgentCatalog = tool(
    async () => json(await options.listBindableAgentSpecs()),
    {
      name: "project_agent_catalog",
      description:
        "List Agent Specs that the Coordinator can bind, including their default responsibilities. Use this before binding an Agent; never guess a Spec key.",
      schema: z.object({}),
    },
  );

  const projectAgentBind = tool(async (input) => json(await options.bindAgent({
    specKey: input.spec_key,
    responsibility: input.responsibility,
  })), {
    name: "project_agent_bind",
    description:
      "Bind an available Agent Spec to the current Project. Coordinator only. Responsibility is optional and is useful when multiple Seats of the same Spec divide the work.",
    schema: z.object({
      spec_key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
      responsibility: z.string().trim().max(500).default(""),
    }),
  });

  const projectAgentRelease = tool(async (input) => json(await options.releaseAgent({
    seatId: input.seat_id,
    reason: input.reason,
  })), {
    name: "project_agent_release",
    description:
      "Release a non-Coordinator Agent Seat after its active Runs and unfinished Tasks are cleared. Coordinator only.",
    schema: z.object({
      seat_id: z.string().uuid(),
      reason: z.string().trim().min(1).max(2_000),
    }),
  });

  return [...tools, projectAgentCatalog, projectAgentBind, projectAgentRelease];
}
