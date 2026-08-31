import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface AgentSpecManifest {
  id: string;
  name: string;
  version: number;
  defaultResponsibility: string;
  prompt: string;
  memory: string;
  sandbox: {
    dockerfile: string;
    image: string;
  };
}

export interface LoadedAgentSpec {
  directory: string;
  manifest: AgentSpecManifest;
  prompt: string;
  memorySeed: string;
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
    typeof manifest.defaultResponsibility !== "string" ||
    !manifest.defaultResponsibility.trim() ||
    typeof manifest.prompt !== "string" ||
    !manifest.prompt.trim() ||
    typeof manifest.memory !== "string" ||
    !manifest.memory.trim() ||
    !manifest.sandbox ||
    typeof manifest.sandbox.dockerfile !== "string" ||
    typeof manifest.sandbox.image !== "string"
  ) {
    throw new Error("Agent Spec manifest is invalid");
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

/** Load the immutable prompt and initial memory from a versioned Agent Spec. */
export async function loadAgentSpec(options: { directory: string }): Promise<LoadedAgentSpec> {
  const directory = await realpath(resolve(options.directory));
  const manifestText = await readSpecFile(directory, "spec.json");
  const manifest = parseManifest(JSON.parse(manifestText) as unknown);
  const [prompt, memorySeed] = await Promise.all([
    readSpecFile(directory, manifest.prompt),
    readSpecFile(directory, manifest.memory),
    readSpecFile(directory, manifest.sandbox.dockerfile),
  ]);
  return {
    directory,
    manifest,
    prompt: prompt.trim(),
    memorySeed: memorySeed.trim(),
  };
}
