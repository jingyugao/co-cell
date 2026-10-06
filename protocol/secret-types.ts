export type SecretFormat = 'text' | 'files';
export interface SecretTextFile { path: string; content: string; encoding?: 'base64' }
export interface SecretFileIdentity { hostname: string; username: string }
export interface SecretFileBundle {
  files: SecretTextFile[]; directory?: string; adapter?: 'meegle'; identity?: SecretFileIdentity;
}
export type ProxyTool = string;
export interface SecretMetadata {
  id: string; name: string; format: SecretFormat; mutable: boolean; enabled: boolean;
  version: number; createdAt: string; updatedAt: string; projectIds: string[];
  tool: ProxyTool | null; path: string | null; requiresTextImport: boolean;
  filePaths?: string[]; directory?: string; adapter?: 'meegle'; identity?: SecretFileIdentity;
}
export interface SecretInput {
  name: string; format: SecretFormat; mutable: boolean; content?: string;
  tool: ProxyTool; path: string;
  files?: SecretTextFile[]; directory?: string; adapter?: 'meegle'; identity?: SecretFileIdentity;
}
export interface SecretUpdate { name?: string; mutable?: boolean; enabled?: boolean; content?: string; tool?: ProxyTool; path?: string;
  format?: SecretFormat; files?: SecretTextFile[]; directory?: string; adapter?: 'meegle'; identity?: SecretFileIdentity }
export interface SecretContent extends Partial<SecretFileBundle> {
  format: SecretFormat; content: string; requiresTextImport: boolean; version: number;
}
export interface SecretDeleteResult { ok: true }
export interface ToolCompletionResult { saved: boolean; discarded?: boolean; versions?: Array<{ secretId: string; version: number }> }
export interface ProvisionedToolFile {
  tool: ProxyTool; secretId: string; path: string; content: string; mutable: boolean; version: number;
  format?: SecretFormat;
}
export interface ToolRuntimeConfig {
  mode: 'files'; boxId: string; revision: number; url: string; files: ProvisionedToolFile[];
  /** Older runners read these aliases. token contains the plain Box ID. */
  generation?: number; token?: string;
}
export interface ToolRuntimeIdentity { boxId: string }
/** Stable descriptor retained in the checkpoint; ordinary resume leaves it unchanged. */
export interface ToolRuntimeMount { mode: 'mount'; path: string }
export interface ToolFileUpdate { secretId: string; content: string; baseVersion: number; format?: SecretFormat }
export interface ToolFileSyncRequest extends ToolRuntimeIdentity { tool: ProxyTool; updates: ToolFileUpdate[]; exitCode: number }
export interface ToolInvocationStartRequest extends ToolRuntimeIdentity { tool: ProxyTool; alias?: string; args: string[] }
export interface ToolInvocationCompleteRequest extends ToolRuntimeIdentity { updates: Array<{ secretId: string; content: string }>; exitCode: number }
export interface SecretVersion {
  id: string; source: 'operator' | 'tool'; baseVersion: number | null;
  createdAt: string; projectId: string | null; invocationId: string | null;
  changes: string[];
}
export interface SecretFileBinding { secretId: string; path: string }
export interface ToolPolicy {
  namespaces: string[]; resources: string[]; commandPrefixes: string[][];
}
export interface ProjectToolGrant {
  id: string; projectId: string; tool: ProxyTool; alias: string; enabled: boolean;
  files: SecretFileBinding[]; updatedAt: string;
  /** Legacy documents can retain this field; authorization no longer uses it. */
  policy?: ToolPolicy;
}
export type ProjectToolGrantInput = Omit<ProjectToolGrant, 'id' | 'projectId' | 'updatedAt'>;
export interface ProjectToolSelection { tool: ProxyTool; secretId: string | null }
/** Only the protected tool runner receives this response, never the agent. */
export interface ToolInvocationSetup {
  id: string; tool: ProxyTool; args: string[];
  files: Array<{ path: string; content: string; secretId: string; version: number; mutable: boolean; format?: SecretFormat }>;
}
