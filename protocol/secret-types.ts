import type { DynamicToolExecution } from './tool-types.js';
export type ProxyTool = string;
/** Stable across resume; carries no credential content or authentication token. */
export interface ToolHomeRuntimeConfig { mode: 'home'; boxId: string; url: string }
/** Generic tools use their native HOME defaults when no path override is configured. */
export interface ToolAuthorization {
  tool: ProxyTool; args: string[]; home: string; path?: string; execution: DynamicToolExecution;
  /** Native CLI writes retain the mounted HOME owner's access to these roots. */
  credentialPaths?: string[];
}
/** Credential names come from dynamic Load hooks, never Secret IDs. */
export interface ToolPermission { tool: ProxyTool; enabled: boolean; credentials?: string[] }
export type ToolCatalogEntry =
  | { name: ProxyTool; kind: 'tool' }
  | { name: ProxyTool; kind: 'tool-with-credential'; credentials: string[]; defaultCredential?: string };
export interface ToolRole { id: string; name: string; permissions: ToolPermission[]; createdAt: string; updatedAt: string }
export interface ToolRoleInput { name: string; permissions: ToolPermission[] }
export interface RoleCatalog { roles: ToolRole[]; defaultRoleId: string }
export interface ProjectRoleAssignment { roleId: string | null }
export interface ProjectRoleState extends ProjectRoleAssignment { permissions: ToolPermission[] }
