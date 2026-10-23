import type { ToolPermission } from '../../protocol/secret-types.js';

export interface CredentialSource { id: string; name: string; version: number; content: string }
export interface CredentialCatalog { names: readonly string[]; defaultName?: string }

/** Lark CLI and other tools with a single project-level access switch. */
export interface Tool {
  readonly name: string;
  readonly kind: 'tool' | 'tool-with-credential';
  authorize(permission: ToolPermission | undefined): void;
  validateArgs(args: readonly string[]): string[];
}

/** Tools that understand the native credential selected by a call. */
export interface ToolWithCredential extends Tool {
  readonly kind: 'tool-with-credential';
  readonly configPath: string;
  /** Absent when the native selector is positional, as in ssh HOST. */
  readonly credentialOption?: string;
  listCredentials(sources: readonly CredentialSource[], mountedConfig?: Buffer): CredentialCatalog;
  /** Resolve only the command's selector; native files are not an authorization source. */
  resolveCredential(args: readonly string[]): string | undefined;
}
