import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentSpecSummary, AgentSpecsResponse } from "../contracts/workbench.js";
import { loadAgentSpec } from "../specs/loader.js";

export interface AgentSpecCatalog {
  list(): Promise<AgentSpecsResponse>;
  get(key: string): Promise<AgentSpecSummary | null>;
  getDefinition?(key: string): Promise<{ prompt: string; memory: string } | null>;
}

export class FilesystemAgentSpecCatalog implements AgentSpecCatalog {
  constructor(private readonly root: string) {}

  async list(): Promise<AgentSpecsResponse> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(this.root, entry.name))
      .sort();
    const loaded = await Promise.all(
      directories.map((directory) => loadAgentSpec({ directory })),
    );
    return {
      items: loaded.map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        defaultResponsibility: manifest.defaultResponsibility,
        memory: manifest.memory,
        sandbox: manifest.sandbox,
        environmentExample: ".env.example",
      })),
    };
  }

  async get(key: string): Promise<AgentSpecSummary | null> {
    const result = await this.list();
    return result.items.find((spec) => spec.id === key) ?? null;
  }

  async getDefinition(key: string): Promise<{ prompt: string; memory: string } | null> {
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const loaded = await loadAgentSpec({ directory: resolve(this.root, entry.name) });
      if (loaded.manifest.id === key) {
        return { prompt: loaded.prompt, memory: loaded.memorySeed };
      }
    }
    return null;
  }
}
