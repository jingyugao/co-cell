export type SecretFormat = 'text' | 'files' | 'home';
/** Native encrypted Linux Lark keychain files accompanying its primary config. */
export interface SecretSupportFile { path: string; content: string; encoding: 'base64' }
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
  /** Credential body storage; database is a pre-migration record. */
  storage?: 'native' | 'database';
  homeDirectory?: string;
  supportFilePaths?: string[];
  /** Native MySQL login-path names or Kubernetes context names; no credential values. */
  nativeNames?: string[];
  filePaths?: string[]; directory?: string; adapter?: 'meegle'; identity?: SecretFileIdentity;
}
export interface SecretInput {
  name: string; format: SecretFormat; mutable: boolean; content?: string;
  tool: ProxyTool; path: string;
  supportFiles?: SecretSupportFile[];
  files?: SecretTextFile[]; directory?: string; adapter?: 'meegle'; identity?: SecretFileIdentity;
}
export interface SecretUpdate { name?: string; mutable?: boolean; enabled?: boolean; content?: string; tool?: ProxyTool; path?: string;
  supportFiles?: SecretSupportFile[];
  format?: SecretFormat; files?: SecretTextFile[]; directory?: string; adapter?: 'meegle'; identity?: SecretFileIdentity }
export interface SecretContent extends Partial<SecretFileBundle> {
  supportFilePaths?: string[];
  format: SecretFormat; content: string; requiresTextImport: boolean; version: number;
}
export interface SecretDeleteResult { ok: true }
export interface ProvisionedToolFile {
  tool: ProxyTool; secretId: string; path: string; content: string; mutable: boolean; version: number;
  alias: string;
  /** Preserve a native HOME-owned file in place rather than seeding it from a Secret snapshot. */
  externallyManaged?: boolean;
  /** Revision of all credentials contributing to a merged native config. */
  revision?: string;
  format?: SecretFormat;
}
/** Stable across resume; carries no credential content or authentication token. */
export interface ToolHomeRuntimeConfig { mode: 'home'; boxId: string; url: string }
/** Generic tools use their native HOME defaults when no path override is configured. */
export interface ToolAuthorization { tool: ProxyTool; args: string[]; home: string; path?: string }
export interface SecretVersion {
  id: string; source: 'operator' | 'tool'; baseVersion: number | null;
  createdAt: string; projectId: string | null; invocationId: string | null;
  changes: string[];
}
/** Native credential names are login-path/context names, never Secret IDs. */
export interface ToolPermission { tool: ProxyTool; enabled: boolean; credentials?: string[] }
export type ToolCatalogEntry =
  | { name: ProxyTool; kind: 'tool' }
  | { name: ProxyTool; kind: 'tool-with-credential'; credentials: string[]; defaultCredential?: string };
export interface ToolRole { id: string; name: string; permissions: ToolPermission[]; createdAt: string; updatedAt: string }
export interface ToolRoleInput { name: string; permissions: ToolPermission[] }
export interface RoleCatalog { roles: ToolRole[]; defaultRoleId: string }
export interface ProjectRoleAssignment { roleId: string | null }
export interface ProjectRoleState extends ProjectRoleAssignment { permissions: ToolPermission[] }
