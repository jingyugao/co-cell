import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentSpecSummary, AgentSpecsResponse } from "../contracts/workbench.js";
import { loadAgentSpec } from "../specs/loader.js";

export interface AgentSpecCatalog {
  list(): Promise<AgentSpecsResponse>;
  get(key: string): Promise<AgentSpecSummary | null>;
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
        knowledge: manifest.knowledge,
        sandbox: manifest.sandbox,
        environmentExample: manifest.environmentExample,
      })),
    };
  }

  async get(key: string): Promise<AgentSpecSummary | null> {
    const result = await this.list();
    return result.items.find((spec) => spec.id === key) ?? null;
  }
}
