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
export interface ProvisionedToolFile {
  tool: ProxyTool; secretId: string; path: string; content: string; mutable: boolean; version: number;
  alias: string;
  format?: SecretFormat;
}
/** Stable across resume; carries no credential content or authentication token. */
export interface ToolHomeRuntimeConfig { mode: 'home'; boxId: string; url: string }
export interface ToolAuthorization { tool: ProxyTool; args: string[]; home: string; path: string }
export interface SecretVersion {
  id: string; source: 'operator' | 'tool'; baseVersion: number | null;
  createdAt: string; projectId: string | null; invocationId: string | null;
  changes: string[];
}
export interface SecretFileBinding { secretId: string; path: string }
export interface ProjectToolGrant {
  id: string; projectId: string; tool: ProxyTool; alias: string; enabled: boolean;
  files: SecretFileBinding[]; updatedAt: string;
}
/** Named credentials granted together to a project. alias is the current original credential name, never user-configurable. */
export interface RoleConnection { tool: ProxyTool; alias: string; secretId: string }
export interface ToolRole { id: string; name: string; connections: RoleConnection[]; createdAt: string; updatedAt: string }
/** Connections are selected by credential ID; their names come from the credential. */
export interface ToolRoleInput { name: string; connections: Array<Pick<RoleConnection, 'tool' | 'secretId'>> }
export interface RoleCatalog { roles: ToolRole[]; defaultRoleId: string }
export interface ProjectRoleAssignment { roleId: string | null }
export interface ProjectRoleState extends ProjectRoleAssignment { connections: RoleConnection[] }
