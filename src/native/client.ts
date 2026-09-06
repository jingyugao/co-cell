import type { NativeEvents, NativeHealth, SdkInput, SdkRun } from "../contracts/native.js";

export interface SdkClientOptions {
  baseUrl: string;
  token: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export class SdkHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SdkHttpError";
  }
}

/** HTTP transport only. requestId identifies a submission, not a native Codex turn. */
export class SdkClient {
  private readonly baseUrl: URL;
  private readonly headers: Headers;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: SdkClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (!/^https?:$/.test(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password) {
      throw new Error("SDK host requires an HTTP(S) URL without embedded credentials");
    }
    if (!options.token) throw new Error("SDK host token is required");
    this.headers = new Headers(options.headers);
    this.headers.set("Authorization", `Bearer ${options.token}`);
    this.headers.set("Content-Type", "application/json");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  health(): Promise<NativeHealth> { return this.send("GET", "/health"); }

  events(after = 0, limit = 200): Promise<NativeEvents> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Invalid SDK event pagination");
    }
    return this.send("GET", `/events?after=${after}&limit=${limit}`);
  }

  run(message: { requestId: string; input: SdkInput; threadId?: string }): Promise<SdkRun> {
    return this.send("POST", "/runs", message);
  }

  interrupt(requestId: string): Promise<SdkRun> {
    return this.send("POST", `/runs/${encodeURIComponent(requestId)}/interrupt`, {});
  }

  private async send<T>(method: string, path: string, message?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(path, this.baseUrl), {
        method,
        headers: this.headers,
        ...(message === undefined ? {} : { body: JSON.stringify(message) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new SdkHttpError(method === "POST"
        ? "SDK transport interrupted; execution outcome is unknown. Check the saved submission before retrying."
        : "SDK host is unreachable", 502);
    }
    if (!response.ok) {
      // Do not echo arbitrary proxy HTML, URLs or credentials in errors.
      throw new SdkHttpError(
        method === "POST" && response.status >= 500
          ? `SDK host HTTP ${response.status}; execution outcome is unknown. Check the saved submission before retrying.`
          : `SDK host HTTP ${response.status}`,
        response.status,
      );
    }
    try { return await response.json() as T; }
    catch {
      throw new SdkHttpError(method === "POST"
        ? "SDK response interrupted; execution outcome is unknown. Check the saved submission before retrying."
        : "Invalid SDK host response", 502);
    }
  }
}
