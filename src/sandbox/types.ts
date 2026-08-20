export type SandboxStatus =
  | "creating"
  | "running"
  | "stopped"
  | "failed"
  | "destroyed";

export interface SandboxResources {
  cpu: number;
  memoryMb: number;
  diskMb?: number;
  pids?: number;
}

export interface WorkspaceRef {
  /** Stable control-plane identifier, independent of the sandbox backend. */
  id: string;
  /** Absolute path exposed to commands inside the sandbox. */
  mountPath: string;
}

export interface SandboxSpec {
  runId: string;
  image: string;
  workspace: WorkspaceRef;
  resources: SandboxResources;
  networkProfile: string;
  workingDirectory?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
  labels?: Readonly<Record<string, string>>;
}

export interface SandboxExecRequest {
  command: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  login?: boolean;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface SandboxContinueRequest {
  sessionId: string;
  chars?: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface SandboxExecResult {
  wallTimeSeconds: number;
  output: string;
  exitCode?: number;
  sessionId?: string;
  originalTokenCount?: number;
}

export interface SandboxInfo {
  id: string;
  provider: string;
  runId: string;
  status: SandboxStatus;
  workspace: WorkspaceRef;
  createdAt: string;
}

export interface Sandbox {
  readonly id: string;

  info(): Promise<SandboxInfo>;
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
  continue(request: SandboxContinueRequest): Promise<SandboxExecResult>;
  stop(options?: { gracePeriodMs?: number }): Promise<void>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;

  create(spec: SandboxSpec): Promise<Sandbox>;
  get(sandboxId: string): Promise<Sandbox | undefined>;
}
