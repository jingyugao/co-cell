import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface AgentSpecKnowledge {
  path: string;
  when?: string;
}

export interface AgentSpecManifest {
  id: string;
  name: string;
  version: number;
  taskPrompt: string;
  knowledge: AgentSpecKnowledge[];
  sandbox: {
    dockerfile: string;
    image: string;
  };
  environmentExample: string;
}

export interface LoadedAgentSpec {
  directory: string;
  manifest: AgentSpecManifest;
  taskPrompt: string;
  instructions: string[];
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function parseManifest(value: unknown): AgentSpecManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Agent Spec manifest must be an object");
  }
  const manifest = value as Partial<AgentSpecManifest>;
  if (
    typeof manifest.id !== "string" ||
    !manifest.id.trim() ||
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    !Number.isInteger(manifest.version) ||
    typeof manifest.taskPrompt !== "string" ||
    !manifest.taskPrompt.trim() ||
    !Array.isArray(manifest.knowledge) ||
    !manifest.sandbox ||
    typeof manifest.sandbox.dockerfile !== "string" ||
    typeof manifest.sandbox.image !== "string" ||
    typeof manifest.environmentExample !== "string"
  ) {
    throw new Error("Agent Spec manifest is invalid");
  }
  for (const entry of manifest.knowledge) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !entry.path.trim() ||
      (entry.when !== undefined && typeof entry.when !== "string")
    ) {
      throw new Error("Agent Spec knowledge entry is invalid");
    }
  }
  return manifest as AgentSpecManifest;
}

async function readSpecFile(
  specRoot: string,
  relativePath: string,
): Promise<string> {
  const candidate = await realpath(resolve(specRoot, relativePath));
  if (!isWithin(specRoot, candidate)) {
    throw new Error(`Agent Spec file is outside the Spec directory: ${relativePath}`);
  }
  return readFile(candidate, "utf8");
}

/** Load deployment knowledge from a versioned Agent Spec. */
export async function loadAgentSpec(options: {
  directory: string;
  capabilities?: ReadonlySet<string>;
}): Promise<LoadedAgentSpec> {
  const directory = await realpath(resolve(options.directory));
  const manifestText = await readSpecFile(directory, "spec.json");
  const manifest = parseManifest(JSON.parse(manifestText) as unknown);
  const [taskPrompt] = await Promise.all([
    readSpecFile(directory, manifest.taskPrompt),
    readSpecFile(directory, manifest.sandbox.dockerfile),
    readSpecFile(directory, manifest.environmentExample),
  ]);
  const capabilities = options.capabilities ?? new Set<string>();
  const activeKnowledge = manifest.knowledge.filter(
    (entry) => !entry.when || capabilities.has(entry.when),
  );
  const instructions = await Promise.all(
    activeKnowledge.map(async (entry) =>
      (await readSpecFile(directory, entry.path)).trim(),
    ),
  );
  return {
    directory,
    manifest,
    taskPrompt: taskPrompt.trim(),
    instructions: instructions.filter(Boolean),
  };
}
