import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CHATGPT_DEVICE_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const CHATGPT_DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
const CHATGPT_DEVICE_REDIRECT_URI =
  "https://auth.openai.com/deviceauth/callback";
const CHATGPT_AUTH_CLAIMS_NAMESPACE = "https://api.openai.com/auth";
const DEFAULT_SCOPE = "openid profile email offline_access";
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface ChatGptToken {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_id?: string;
  plan_type?: string;
  user_id?: string;
  id_token?: string;
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface DeviceStartResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
}

interface DevicePollResponse {
  authorization_code?: string;
  error?: string;
}

export function defaultAuthPath(): string {
  return resolve(
    process.env.SWARM_HIVE_AUTH_FILE ??
      `${homedir()}/.swarm-hive/chatgpt-auth.json`,
  );
}

function decodeJwtClaims(token?: string): Record<string, unknown> {
  if (!token) return {};
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function claimsFromIdToken(idToken?: string): {
  account_id?: string;
  plan_type?: string;
  user_id?: string;
} {
  const claims = decodeJwtClaims(idToken);
  const auth = claims[CHATGPT_AUTH_CLAIMS_NAMESPACE];
  const authClaims =
    auth && typeof auth === "object" ? (auth as Record<string, unknown>) : {};
  const asString = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  return {
    account_id:
      asString(authClaims.chatgpt_account_id) ?? asString(claims.chatgpt_account_id),
    plan_type: asString(authClaims.chatgpt_plan_type),
    user_id: asString(authClaims.chatgpt_user_id) ?? asString(claims.sub),
  };
}

function tokenFromResponse(
  payload: OAuthTokenResponse,
  fallbackRefreshToken?: string,
): ChatGptToken {
  if (!payload.access_token) {
    throw new Error("OAuth response is missing access_token");
  }
  const refreshToken = payload.refresh_token ?? fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error("OAuth response is missing refresh_token; login again");
  }
  const expiresIn = Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("OAuth response has an invalid expires_in value");
  }
  return {
    access_token: payload.access_token,
    refresh_token: refreshToken,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    id_token: payload.id_token,
    ...claimsFromIdToken(payload.id_token),
  };
}

async function postForm<T>(url: string, values: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`OAuth endpoint returned non-JSON (${response.status})`);
  }
  if (!response.ok) {
    const error = payload as OAuthTokenResponse;
    throw new Error(
      `OAuth request failed (${response.status}): ${
        error.error_description ?? error.error ?? "unknown error"
      }`,
    );
  }
  return payload as T;
}

async function pollDeviceCode(
  values: Record<string, string>,
): Promise<DevicePollResponse> {
  const response = await fetch(CHATGPT_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
  const payload = (await response.json()) as DevicePollResponse;
  if (
    !response.ok &&
    payload.error !== "authorization_pending" &&
    payload.error !== "slow_down"
  ) {
    throw new Error(
      `Device authorization failed (${response.status}): ${
        payload.error ?? "unknown error"
      }`,
    );
  }
  return payload;
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return { verifier, challenge };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((done) => setTimeout(done, milliseconds));
}

export class FileChatGptTokenProvider {
  readonly path: string;
  private refreshPromise?: Promise<ChatGptToken>;

  constructor(path = defaultAuthPath()) {
    this.path = resolve(path);
  }

  async read(): Promise<ChatGptToken> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`No ChatGPT OAuth token at ${this.path}; run pnpm auth`);
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<ChatGptToken>;
    if (
      !parsed.access_token ||
      !parsed.refresh_token ||
      !parsed.expires_at
    ) {
      throw new Error(`Invalid ChatGPT OAuth token file: ${this.path}`);
    }
    return parsed as ChatGptToken;
  }

  async save(token: ChatGptToken): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(token, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600).catch(() => undefined);
  }

  async getToken(): Promise<ChatGptToken> {
    const existing = await this.read();
    if (
      new Date(existing.expires_at).getTime() - DEFAULT_REFRESH_SKEW_MS >
      Date.now()
    ) {
      return existing;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(existing).finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async refresh(existing: ChatGptToken): Promise<ChatGptToken> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let lock;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        lock = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await sleep(100);
      }
    }
    if (!lock) throw new Error(`Timed out waiting for OAuth lock: ${lockPath}`);
    try {
      const latest = await this.read();
      if (
        new Date(latest.expires_at).getTime() - DEFAULT_REFRESH_SKEW_MS >
        Date.now()
      ) {
        return latest;
      }
      const response = await postForm<OAuthTokenResponse>(CHATGPT_TOKEN_URL, {
        grant_type: "refresh_token",
        refresh_token: latest.refresh_token ?? existing.refresh_token,
        client_id: CHATGPT_CLIENT_ID,
      });
      const refreshed = tokenFromResponse(response, latest.refresh_token);
      await this.save(refreshed);
      return refreshed;
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

export async function loginWithDeviceCode(options?: {
  path?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onCode?: (verificationUri: string, userCode: string) => void;
}): Promise<FileChatGptTokenProvider> {
  const provider = new FileChatGptTokenProvider(options?.path);
  const { verifier, challenge } = createPkcePair();
  const start = await postForm<DeviceStartResponse>(CHATGPT_DEVICE_CODE_URL, {
    client_id: CHATGPT_CLIENT_ID,
    scope: DEFAULT_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const verificationUri =
    start.verification_uri ?? start.verification_uri_complete;
  if (!start.device_code || !start.user_code || !verificationUri) {
    throw new Error("Device-code response is missing required fields");
  }
  options?.onCode?.(verificationUri, start.user_code);

  const deadline = Date.now() + (options?.timeoutMs ?? 10 * 60 * 1000);
  let interval = options?.pollIntervalMs ?? 5_000;
  let authorizationCode: string | undefined;
  while (Date.now() < deadline) {
    const poll = await pollDeviceCode({
      client_id: CHATGPT_CLIENT_ID,
      device_code: start.device_code,
    });
    if (poll.authorization_code) {
      authorizationCode = poll.authorization_code;
      break;
    }
    if (poll.error === "slow_down") interval += 5_000;
    else if (poll.error && poll.error !== "authorization_pending") {
      throw new Error(`Device authorization failed: ${poll.error}`);
    }
    await sleep(interval);
  }
  if (!authorizationCode) {
    throw new Error("Timed out waiting for ChatGPT device authorization");
  }

  const response = await postForm<OAuthTokenResponse>(CHATGPT_TOKEN_URL, {
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: CHATGPT_DEVICE_REDIRECT_URI,
    client_id: CHATGPT_CLIENT_ID,
    code_verifier: verifier,
  });
  await provider.save(tokenFromResponse(response));
  return provider;
}

export const oauthInternalsForTest = {
  claimsFromIdToken,
  tokenFromResponse,
};
