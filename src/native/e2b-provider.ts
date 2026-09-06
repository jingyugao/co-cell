import { Sandbox as E2BSandbox, type SandboxConnectOpts, type SandboxOpts } from "e2b";

import { redactSensitiveText } from "../security/redact.js";

export interface WorkspaceCommandOptions {
  cwd?: string;
  envs?: Record<string, string>;
  user?: string;
  /** A command timeout, not the lifetime of the workspace. Zero disables it. */
  timeoutMs?: number;
}

export interface WorkspaceCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A durable development environment. Intentionally has no destructive kill API. */
export interface WorkspaceSandbox {
  readonly id: string;
  exec(command: string, options?: WorkspaceCommandOptions): Promise<WorkspaceCommandResult>;
  start(command: string, options?: WorkspaceCommandOptions): Promise<{ pid: number }>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  pause(): Promise<void>;
  renewTimeout(timeoutMs?: number): Promise<void>;
  getHost(port: number): string;
  /** Complete backend-only URL, including an explicitly configured local proxy. */
  getProxyUrl(port: number): string;
  /** For the server-side bridge proxy only; never send these headers to browsers. */
  getProxyHeaders(port?: number): Record<string, string>;
}

export interface WorkspaceSandboxProvider {
  create(workspaceId: string): Promise<WorkspaceSandbox>;
  /** A missing environment is an error, never permission to create a replacement. */
  connect(sandboxId: string): Promise<WorkspaceSandbox>;
}

interface E2BBackgroundHandle {
  pid: number;
  disconnect(): Promise<void>;
}

/** The small part of the official SDK used here, so lifecycle tests need no VM. */
export interface E2BSandboxConnection {
  sandboxId: string;
  trafficAccessToken?: string;
  commands: {
    run(command: string, options: WorkspaceCommandOptions & { background: true }): Promise<E2BBackgroundHandle>;
    run(command: string, options?: WorkspaceCommandOptions & { background?: false }): Promise<WorkspaceCommandResult>;
  };
  files: {
    write(path: string, content: string, options?: { user?: string }): Promise<unknown>;
    read(path: string, options?: { user?: string }): Promise<string>;
  };
  pause(options?: { keepMemory?: boolean }): Promise<boolean>;
  setTimeout(timeoutMs: number): Promise<void>;
  getHost(port: number): string;
}

export interface E2BWorkspaceSdk {
  create(template: string, options: SandboxOpts): Promise<E2BSandboxConnection>;
  connect(sandboxId: string, options: SandboxConnectOpts): Promise<E2BSandboxConnection>;
}

export interface E2BWorkspaceProviderOptions {
  apiKey: string;
  /** Required explicitly: an unset value must not silently select E2B Cloud. */
  domain: string;
  apiUrl?: string;
  /** Explicit origin for a header-routed sandbox proxy, such as local client-proxy. */
  sandboxUrl?: string;
  template: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  /** Only these explicit variables are passed to the guest, not process.env. */
  envs?: Record<string, string>;
  sdk?: E2BWorkspaceSdk;
}

export class E2BWorkspaceError extends Error {
  constructor(message: string, readonly operation: string) {
    super(message);
    this.name = "E2BWorkspaceError";
  }
}

const DEFAULT_WORKSPACE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const SECRET_ENV_NAME = /TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY|CREDENTIAL/i;

const defaultSdk: E2BWorkspaceSdk = {
  create: (template, options) => E2BSandbox.create(template, options),
  connect: (sandboxId, options) => E2BSandbox.connect(sandboxId, options),
};

export class E2BWorkspaceProvider implements WorkspaceSandboxProvider {
  readonly #sdk: E2BWorkspaceSdk;
  readonly #connection: SandboxConnectOpts;
  readonly #template: string;
  readonly #timeoutMs: number;
  readonly #envs: Record<string, string>;
  readonly #secrets: string[];

  constructor(options: E2BWorkspaceProviderOptions) {
    const sandboxUrl = options.sandboxUrl === undefined ? undefined : validateSandboxUrl(options.sandboxUrl);
    if (sandboxUrl === undefined && process.env.E2B_SANDBOX_URL?.trim()) {
      throw new Error("Remove ambient E2B_SANDBOX_URL; workspace traffic must use the explicitly configured E2B domain");
    }
    const apiKey = required(options.apiKey, "E2B API key");
    const domain = required(options.domain, "E2B domain");
    if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?(?::[1-9]\d{0,4})?$/i.test(domain)) {
      throw new Error("E2B domain must be an explicit hostname, without credentials or a URL path");
    }
    this.#template = required(options.template, "E2B template");
    this.#timeoutMs = positiveTimeout(options.timeoutMs ?? DEFAULT_WORKSPACE_TIMEOUT_MS);
    const apiUrl = options.apiUrl ?? `https://api.${domain}`;
    validateApiUrl(apiUrl);
    // The SDK otherwise accepts ambient E2B_DEBUG / E2B_API_URL overrides.
    this.#connection = {
      apiKey,
      domain,
      apiUrl,
      ...(sandboxUrl === undefined ? {} : { sandboxUrl }),
      debug: false,
      timeoutMs: this.#timeoutMs,
      requestTimeoutMs: positiveTimeout(options.requestTimeoutMs ?? 60_000),
    };
    this.#envs = { ...options.envs };
    this.#secrets = [apiKey, ...secretValues(this.#envs)];
    this.#sdk = options.sdk ?? defaultSdk;
  }

  async create(workspaceId: string): Promise<WorkspaceSandbox> {
    required(workspaceId, "Workspace ID");
    try {
      const connection = await this.#sdk.create(this.#template, {
        ...this.#connection,
        metadata: { swarm_hive_workspace_id: workspaceId },
        envs: { ...this.#envs },
        secure: true,
        network: { allowPublicTraffic: false },
        lifecycle: { onTimeout: "pause", autoResume: false },
      });
      return new PersistentE2BWorkspace(connection, this.#timeoutMs, this.#secrets, this.#connection.sandboxUrl);
    } catch (error) {
      throw safeError("create", error, this.#secrets);
    }
  }

  async connect(sandboxId: string): Promise<WorkspaceSandbox> {
    required(sandboxId, "Sandbox ID");
    try {
      const connection = await this.#sdk.connect(sandboxId, { ...this.#connection });
      if (connection.sandboxId !== sandboxId) {
        throw new Error("E2B returned a different sandbox; refusing to replace the saved workspace");
      }
      return new PersistentE2BWorkspace(connection, this.#timeoutMs, this.#secrets, this.#connection.sandboxUrl);
    } catch (error) {
      // In particular, a 404 must not fall back to create: the original disk may
      // need operator recovery, and replacing its ID would hide that data loss.
      throw safeError("connect", error, this.#secrets);
    }
  }
}

class PersistentE2BWorkspace implements WorkspaceSandbox {
  readonly id: string;
  readonly #connection: E2BSandboxConnection;
  readonly #timeoutMs: number;
  readonly #secrets: string[];
  readonly #sandboxUrl: string | undefined;

  constructor(connection: E2BSandboxConnection, timeoutMs: number, secrets: string[], sandboxUrl?: string) {
    this.id = connection.sandboxId;
    this.#connection = connection;
    this.#timeoutMs = timeoutMs;
    this.#secrets = [...secrets, connection.trafficAccessToken ?? ""];
    this.#sandboxUrl = sandboxUrl;
  }

  async exec(command: string, options: WorkspaceCommandOptions = {}): Promise<WorkspaceCommandResult> {
    validateCommandTimeout(options.timeoutMs);
    try {
      return commandResult(await this.#connection.commands.run(command, {
        ...options,
        timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        background: false,
      }));
    } catch (error) {
      // E2B throws for a non-zero shell exit. Preserve the normal exec contract,
      // including stdout/stderr, so callers can handle a failed build themselves.
      if (isCommandResult(error)) return commandResult(error);
      throw safeError("exec", error, [...this.#secrets, ...secretValues(options.envs)]);
    }
  }

  async start(command: string, options: WorkspaceCommandOptions = {}): Promise<{ pid: number }> {
    validateCommandTimeout(options.timeoutMs);
    try {
      const handle = await this.#connection.commands.run(command, {
        ...options,
        background: true,
        timeoutMs: options.timeoutMs ?? 0,
      });
      // The sandbox-owned bridge journals its output. Detach only the SDK stream;
      // disconnect does not kill the background process and permits reconnects.
      await handle.disconnect();
      return { pid: handle.pid };
    } catch (error) {
      throw safeError("start", error, [...this.#secrets, ...secretValues(options.envs)]);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    try {
      // The native runtime owns /home/user and executes as user. Do not inherit
      // a custom template's root default and create unreadable 0600 auth files.
      await this.#connection.files.write(path, content, { user: "user" });
    } catch {
      // File contents can contain bootstrap credentials; never include an SDK
      // error body that might have echoed even a fragment of the upload payload.
      throw new E2BWorkspaceError("E2B writeFile failed; check sandbox availability and file permissions", "writeFile");
    }
  }

  async readFile(path: string): Promise<string> {
    try {
      return await this.#connection.files.read(path, { user: "user" });
    } catch (error) {
      throw safeError("readFile", error, this.#secrets);
    }
  }

  async pause(): Promise<void> {
    try {
      await this.#connection.pause({ keepMemory: true });
    } catch (error) {
      throw safeError("pause", error, this.#secrets);
    }
  }

  async renewTimeout(timeoutMs = this.#timeoutMs): Promise<void> {
    positiveTimeout(timeoutMs);
    try {
      await this.#connection.setTimeout(timeoutMs);
    } catch (error) {
      throw safeError("renewTimeout", error, this.#secrets);
    }
  }

  getHost(port: number): string {
    validatePort(port);
    return this.#connection.getHost(port);
  }

  getProxyUrl(port: number): string {
    validatePort(port);
    return this.#sandboxUrl ?? `https://${this.#connection.getHost(port)}`;
  }

  getProxyHeaders(port = 4096): Record<string, string> {
    validatePort(port);
    const token = this.#connection.trafficAccessToken;
    if (!token) {
      throw new E2BWorkspaceError("E2B did not provide a restricted-traffic token; sandbox proxy access is disabled", "getProxyHeaders");
    }
    return {
      "e2b-traffic-access-token": token,
      ...(this.#sandboxUrl === undefined ? {} : {
        "e2b-sandbox-id": this.id,
        "e2b-sandbox-port": String(port),
      }),
    };
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Sandbox port must be an integer between 1 and 65535");
  }
}

function required(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be configured explicitly`);
  }
  return value.trim();
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Workspace timeout must be a positive integer in milliseconds");
  }
  return value;
}

function validateCommandTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Command timeout must be a non-negative integer in milliseconds");
  }
}

function validateApiUrl(value: string): void {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("invalid URL");
    }
  } catch {
    throw new Error("E2B API URL must be HTTP(S), without embedded credentials, query, or fragment");
  }
}

function validateSandboxUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || value.includes("?") || value.includes("#")) {
      throw new Error("invalid URL");
    }
    return url.origin;
  } catch {
    throw new Error("E2B sandbox URL must be an HTTP(S) origin, without embedded credentials, path, query, or fragment");
  }
}

function secretValues(envs: Record<string, string> = {}): string[] {
  return Object.entries(envs).filter(([key]) => SECRET_ENV_NAME.test(key)).map(([, value]) => value);
}

function isCommandResult(value: unknown): value is WorkspaceCommandResult {
  return value !== null && typeof value === "object"
    && "exitCode" in value && typeof value.exitCode === "number"
    && "stdout" in value && typeof value.stdout === "string"
    && "stderr" in value && typeof value.stderr === "string";
}

function commandResult(value: WorkspaceCommandResult): WorkspaceCommandResult {
  return { stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode };
}

function safeError(operation: string, error: unknown, secrets: string[]): E2BWorkspaceError {
  let message = error instanceof Error ? error.message : "Unknown E2B error";
  for (const value of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(value, "[REDACTED]");
  }
  // Do not attach the original error as `cause`; request headers and upload
  // bodies in SDK errors must not escape into API responses or persisted logs.
  return new E2BWorkspaceError(`E2B ${operation} failed: ${redactSensitiveText(message).slice(0, 2_000)}`, operation);
}
