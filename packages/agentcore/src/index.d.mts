import { EventEmitter } from 'node:events';
import type { ThreadEvent } from './types.js';
export type * from './types.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RpcError { code: number; message: string; data?: unknown }
export interface AppServerEvent { method: string; params?: any }
export interface AppServerClientOptions { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; requestTimeoutMs?: number }
export class AppServerRpcError extends Error { readonly rpc: RpcError; constructor(rpc: RpcError, method: string); }
export class CodexAppServerClient extends EventEmitter {
  constructor(options?: AppServerClientOptions);
  static spawn(options?: AppServerClientOptions): Promise<CodexAppServerClient>;
  connect(): Promise<void>;
  request<T = any>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, error: RpcError): void;
  events(): AsyncIterableIterator<AppServerEvent>;
  threadStart(params: unknown): Promise<any>;
  threadResume(params: unknown): Promise<any>;
  turnStart(params: unknown): Promise<any>;
  turnInterrupt(params: unknown): Promise<any>;
  close(): Promise<void>;
}
export type AgentEvent = ThreadEvent;
export class AppServerEventAdapter { accept(event: AppServerEvent): AgentEvent[]; }
export type UserInput = { type: 'text'; text: string } | { type: 'local_image'; path: string };
export type Input = string | UserInput[];
export interface CodexOptions { codexPathOverride?: string; config?: Record<string, unknown>; configOverrides?: string[]; apiKey?: string; baseUrl?: string; env?: Record<string, string> }
export interface ThreadOptions {
 model?: string; workingDirectory?: string; sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
 modelReasoningEffort?: string; webSearchMode?: 'disabled' | 'cached' | 'live'; networkAccessEnabled?: boolean;
 approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted'; additionalDirectories?: string[]; skipGitRepoCheck?: boolean;
}
export class Codex { constructor(options?: CodexOptions); startThread(options?: ThreadOptions): Thread; resumeThread(id: string, options?: ThreadOptions): Thread; close(): Promise<void>; }
export class Thread { readonly id: string | null; runStreamed(input: Input, options?: { signal?: AbortSignal; outputSchema?: unknown }): Promise<{ events: AsyncGenerator<AgentEvent> }>; }
