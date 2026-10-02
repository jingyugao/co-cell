export type SecretFormat = 'text';
export type ProxyTool = string;
export interface SecretMetadata {
  id: string; name: string; format: SecretFormat; mutable: boolean; enabled: boolean;
  version: number; createdAt: string; updatedAt: string; projectIds: string[];
  tool: ProxyTool | null; path: string | null; requiresTextImport: boolean;
}
export interface SecretInput {
  name: string; format: SecretFormat; mutable: boolean; content: string;
  tool: ProxyTool; path: string;
}
export interface SecretUpdate { name?: string; mutable?: boolean; enabled?: boolean; content?: string; tool?: ProxyTool; path?: string }
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
  files: Array<{ path: string; content: string; secretId: string; version: number; mutable: boolean }>;
}
