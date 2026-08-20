import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface AgentTemplateKnowledge {
  path: string;
  when?: string;
}

export interface AgentTemplateManifest {
  id: string;
  name: string;
  version: number;
  knowledge: AgentTemplateKnowledge[];
  sandbox: {
    dockerfile: string;
    image: string;
  };
  environmentExample: string;
}

export interface LoadedAgentTemplate {
  directory: string;
  manifest: AgentTemplateManifest;
  instructions: string[];
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function parseManifest(value: unknown): AgentTemplateManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Agent template manifest must be an object");
  }
  const manifest = value as Partial<AgentTemplateManifest>;
  if (
    typeof manifest.id !== "string" ||
    !manifest.id.trim() ||
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    !Number.isInteger(manifest.version) ||
    !Array.isArray(manifest.knowledge) ||
    !manifest.sandbox ||
    typeof manifest.sandbox.dockerfile !== "string" ||
    typeof manifest.sandbox.image !== "string" ||
    typeof manifest.environmentExample !== "string"
  ) {
    throw new Error("Agent template manifest is invalid");
  }
  for (const entry of manifest.knowledge) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !entry.path.trim() ||
      (entry.when !== undefined && typeof entry.when !== "string")
    ) {
      throw new Error("Agent template knowledge entry is invalid");
    }
  }
  return manifest as AgentTemplateManifest;
}

async function readTemplateFile(
  templateRoot: string,
  relativePath: string,
): Promise<string> {
  const candidate = await realpath(resolve(templateRoot, relativePath));
  if (!isWithin(templateRoot, candidate)) {
    throw new Error(`Template file is outside the template directory: ${relativePath}`);
  }
  return readFile(candidate, "utf8");
}

/** Load deployment knowledge from a versioned Agent Staff template. */
export async function loadAgentTemplate(options: {
  directory: string;
  capabilities?: ReadonlySet<string>;
}): Promise<LoadedAgentTemplate> {
  const directory = await realpath(resolve(options.directory));
  const manifestText = await readTemplateFile(directory, "template.json");
  const manifest = parseManifest(JSON.parse(manifestText) as unknown);
  await Promise.all([
    readTemplateFile(directory, manifest.sandbox.dockerfile),
    readTemplateFile(directory, manifest.environmentExample),
  ]);
  const capabilities = options.capabilities ?? new Set<string>();
  const activeKnowledge = manifest.knowledge.filter(
    (entry) => !entry.when || capabilities.has(entry.when),
  );
  const instructions = await Promise.all(
    activeKnowledge.map(async (entry) =>
      (await readTemplateFile(directory, entry.path)).trim(),
    ),
  );
  return {
    directory,
    manifest,
    instructions: instructions.filter(Boolean),
  };
}
