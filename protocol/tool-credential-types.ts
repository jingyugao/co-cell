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

export interface ToolCredentialTree {
  tool: string;
  home: string;
  roots: string[];
  entries: ToolCredentialEntry[];
  /** Inventory revision used by create-only installation. */
  version: string;
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

/** Operator installation adds missing files without replacing existing credentials. */
export interface ToolCredentialInitialize {
  version: string;
  directories: string[];
  files: Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }>;
}
export interface ToolCredentialInitialization {
  created: string[];
  skipped: string[];
}
