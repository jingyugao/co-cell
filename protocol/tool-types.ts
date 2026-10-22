/** Operator-managed tool definitions. Credential values remain in native HOME files. */
export interface DynamicToolInput {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  /** Command in the managed PATH, absolute native executable, or package-relative path. */
  executable: string;
  packageVersion?: string;
  args: string[];
  /** Literal values with optional ${HOME} and ${CREDENTIAL} substitutions. */
  env: Record<string, string>;
  credentialPath?: string;
  /** Files or directories relative to the tool's debug HOME. */
  credentialPaths?: string[];
  permissionScriptId?: string;
  /** Load hook: receives the credential path and Base64 file contents. */
  credentialParseScriptId?: string;
  /** Save hook: runs for every content save, regardless of editor encoding. */
  credentialSaveScriptId?: string;
  /** @deprecated Migrate inline bodies to ToolScript records and store the ID. */
  permissionScript?: string;
  timeoutMs: number;
}
/** A new definition may rely on server defaults for fields hidden by the UI. */
export interface DynamicToolCreateInput extends Partial<Omit<DynamicToolInput, 'name'>> {
  name: string;
}
/** Permission checks receive grants and command metadata, never credential contents. */
export interface ToolPermissionCheckInput {
  tool: string;
  args: string[];
  projectId: string;
  boxId: string;
  permission: { tool: string; enabled: boolean; credentials?: string[] };
}
export interface DynamicTool extends DynamicToolInput {
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ToolPackageFileInput {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  executable: boolean;
}
export interface ToolPackageInput { files: ToolPackageFileInput[] }
export interface ToolPackage {
  version: string;
  files: Array<{ path: string; size: number; executable: boolean; sha256: string }>;
}
/** Broker-selected execution details; the caller never supplies these directly. */
export interface DynamicToolExecution {
  executable: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}
