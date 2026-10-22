/** Server-selected native CLI context, available only to credential hooks. */
export interface ToolCredentialHookContext {
  tool: string;
  primaryPath?: string;
  identity?: { hostname: string; username: string };
  targetIdentity?: { hostname: string; username: string };
}

export interface ToolCredentialEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  updatedAt?: string;
}

export interface ToolCredentialRegistration {
  id: string;
  name: string;
  path: string | null;
  enabled: boolean;
  format: string;
  version: number;
  files: string[];
}

export interface ToolCredentialTree {
  tool: string;
  home: string;
  roots: string[];
  entries: ToolCredentialEntry[];
  registrations: ToolCredentialRegistration[];
}

export interface ToolCredentialFile {
  path: string;
  content: string;
  /** Selected by the Load hook; parsed content needs a Save hook. */
  encoding: 'utf8' | 'base64' | 'parsed';
  version: string;
  scriptVersion: number;
  size: number;
  names?: string[];
  editable: boolean;
}

export interface ToolCredentialWrite {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64' | 'parsed';
  version: string;
  scriptVersion: number;
}
