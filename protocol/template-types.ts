export interface TemplateManifest {
  template: string;
  systemPackages: string[];
  extraMiseTools: string[];
  go: string[];
  node: string[];
  python: string[];
  php?: { version: '8.0.30'; composer: { version: string; sha256: string } };
  defaults: { go: string; node: string; python: string };
  mise: { version: string; sha256: string };
  uv: { version: string; sha256: string };
  pnpm: string;
  codexCli: string;
  cpuCount: number;
  memoryMB: number;
}
export interface TemplateDefinition {
  id: string;
  name: string;
  manifest: TemplateManifest;
  version: string;
  createdAt: string;
  updatedAt: string;
}
export interface TemplateBuild {
  id: string;
  templateId: string;
  templateName: string;
  status: 'building' | 'verifying' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  reference?: string;
  error?: string;
  logs: string;
  verification?: {
    passed: boolean;
    checks: Array<{ name: string; output?: string; exitCode?: number; failed?: boolean }>;
    deleted?: boolean;
  };
  manifest: TemplateManifest;
}
export interface TemplateInventory {
  templates: TemplateDefinition[];
  builds: TemplateBuild[];
  defaultTemplate: string;
  activeBuildId: string | null;
  enabled: boolean;
}
