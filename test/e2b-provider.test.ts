import { describe, expect, test, vi } from "vitest";

import {
  E2BWorkspaceError,
  E2BWorkspaceProvider,
  type E2BSandboxConnection,
  type E2BWorkspaceProviderOptions,
  type WorkspaceCommandOptions,
} from "../src/native/e2b-provider.js";

function fixture(overrides: Partial<E2BWorkspaceProviderOptions> = {}) {
  const disconnect = vi.fn(async () => {});
  const run = vi.fn(async (_command: string, options?: WorkspaceCommandOptions & { background?: boolean }) => {
    return options?.background
      ? { pid: 42, disconnect }
      : { stdout: "hello\n", stderr: "", exitCode: 0 };
  });
  const read = vi.fn(async () => "# project state\n");
  const write = vi.fn(async () => ({}));
  const pause = vi.fn(async () => true);
  const setTimeout = vi.fn(async () => {});
  const connection: E2BSandboxConnection = {
    sandboxId: "sandbox-existing",
    trafficAccessToken: "traffic-secret",
    commands: { run: run as E2BSandboxConnection["commands"]["run"] },
    files: { read, write },
    pause,
    setTimeout,
    getHost: (port) => `${port}-sandbox-existing.sandboxes.example.test`,
  };
  const sdk = {
    create: vi.fn(async () => connection),
    connect: vi.fn(async () => connection),
  };
  const options: E2BWorkspaceProviderOptions = {
    apiKey: "e2b-secret",
    domain: "sandboxes.example.test",
    template: "codex-workspace-v1",
    timeoutMs: 900_000,
    sdk,
    ...overrides,
  };
  return { options, sdk, connection, run, disconnect, read, write, pause, setTimeout };
}

describe("E2BWorkspaceProvider", () => {
  test("creates persistent, private workspaces with only explicit guest environment variables", async () => {
    const { options, sdk } = fixture({ envs: { LANG: "C.UTF-8", GITLAB_TOKEN: "gitlab-secret" } });
    const provider = new E2BWorkspaceProvider(options);
    const workspace = await provider.create("project-123");

    expect(workspace.id).toBe("sandbox-existing");
    expect(sdk.create).toHaveBeenCalledExactlyOnceWith("codex-workspace-v1", {
      apiKey: "e2b-secret",
      domain: "sandboxes.example.test",
      apiUrl: "https://api.sandboxes.example.test",
      debug: false,
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
      metadata: { swarm_hive_workspace_id: "project-123" },
      envs: { LANG: "C.UTF-8", GITLAB_TOKEN: "gitlab-secret" },
      secure: true,
      network: { allowPublicTraffic: false },
      lifecycle: { onTimeout: "pause", autoResume: false },
    });
    expect(JSON.stringify(provider)).not.toContain("secret");
    expect(JSON.stringify(workspace)).toBe('{"id":"sandbox-existing"}');
    expect("kill" in workspace).toBe(false);
    expect("destroy" in workspace).toBe(false);
  });

  test("reconnects exactly the recorded sandbox without rebuilding or initializing it", async () => {
    const { options, sdk, run, write } = fixture({ apiUrl: "http://e2b-api.internal:3000" });
    const workspace = await new E2BWorkspaceProvider(options).connect("sandbox-existing");
    expect(workspace.id).toBe("sandbox-existing");
    expect(sdk.connect).toHaveBeenCalledExactlyOnceWith("sandbox-existing", expect.objectContaining({
      domain: "sandboxes.example.test",
      apiUrl: "http://e2b-api.internal:3000",
      timeoutMs: 900_000,
    }));
    expect(sdk.create).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test("does not replace an unavailable or missing sandbox", async () => {
    const { options, sdk } = fixture();
    sdk.connect.mockRejectedValueOnce(new Error("404 sandbox not found"));
    await expect(new E2BWorkspaceProvider(options).connect("sandbox-existing"))
      .rejects.toThrow("E2B connect failed: 404 sandbox not found");
    expect(sdk.create).not.toHaveBeenCalled();
  });

  test("rejects a different sandbox returned by the provider", async () => {
    const { options, connection, sdk } = fixture();
    connection.sandboxId = "wrong-workspace";
    await expect(new E2BWorkspaceProvider(options).connect("sandbox-existing"))
      .rejects.toThrow("different sandbox");
    expect(sdk.create).not.toHaveBeenCalled();
  });

  test("requires explicit endpoint, API key, template and valid timeout before any API call", () => {
    const { options, sdk } = fixture();
    for (const invalid of [
      { apiKey: "" }, { domain: "" }, { template: " " },
      { domain: "https://sandboxes.example.test" },
      { domain: "user:password@example.test" },
      { apiUrl: "https://user:password@example.test" },
      { apiUrl: "https://example.test?api_key=secret" },
      { apiUrl: "file:///tmp/api" },
      { timeoutMs: 0 }, { timeoutMs: Number.NaN }, { timeoutMs: -1 },
    ]) {
      expect(() => new E2BWorkspaceProvider({ ...options, ...invalid })).toThrow();
    }
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  test("rejects ambient sandbox URL overrides before any credential-bearing SDK call", () => {
    const { options, sdk } = fixture();
    vi.stubEnv("E2B_SANDBOX_URL", "https://unintended-endpoint.invalid");
    try {
      expect(() => new E2BWorkspaceProvider(options)).toThrow("Remove ambient E2B_SANDBOX_URL");
      expect(sdk.create).not.toHaveBeenCalled();
      expect(sdk.connect).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  test("explicit sandbox proxy overrides ambient routing for create and connect without weakening security", async () => {
    const { options, sdk } = fixture({ sandboxUrl: "http://127.0.0.1:13002/" });
    vi.stubEnv("E2B_SANDBOX_URL", "https://unintended-endpoint.invalid");
    vi.stubEnv("E2B_API_URL", "https://unintended-api.invalid");
    vi.stubEnv("E2B_DEBUG", "true");
    try {
      const provider = new E2BWorkspaceProvider(options);
      const created = await provider.create("project-123");
      const connected = await provider.connect("sandbox-existing");
      expect(sdk.create).toHaveBeenCalledExactlyOnceWith("codex-workspace-v1", expect.objectContaining({
        apiUrl: "https://api.sandboxes.example.test",
        sandboxUrl: "http://127.0.0.1:13002",
        debug: false,
        secure: true,
        network: { allowPublicTraffic: false },
        lifecycle: { onTimeout: "pause", autoResume: false },
      }));
      expect(sdk.connect).toHaveBeenCalledExactlyOnceWith("sandbox-existing", expect.objectContaining({
        apiUrl: "https://api.sandboxes.example.test",
        sandboxUrl: "http://127.0.0.1:13002",
        debug: false,
      }));
      for (const workspace of [created, connected]) {
        expect(workspace.getProxyUrl(4096)).toBe("http://127.0.0.1:13002");
        expect(workspace.getProxyHeaders()).toEqual({
          "e2b-traffic-access-token": "traffic-secret",
          "e2b-sandbox-id": "sandbox-existing",
          "e2b-sandbox-port": "4096",
        });
        expect(JSON.stringify(workspace)).toBe('{"id":"sandbox-existing"}');
      }
    } finally { vi.unstubAllEnvs(); }
  });

  test.each([
    "", " ", "file:///tmp/proxy", "ftp://example.test", "//example.test",
    "http://user:password@127.0.0.1:13002", "https://user@example.test",
    "http://127.0.0.1:13002/proxy", "http://127.0.0.1:13002/?token=secret",
    "http://127.0.0.1:13002/#secret", "http://127.0.0.1:13002?", "http://127.0.0.1:13002#",
  ])("rejects invalid explicit sandbox proxy %j before SDK calls", (sandboxUrl) => {
    const { options, sdk } = fixture({ sandboxUrl });
    vi.stubEnv("E2B_SANDBOX_URL", "https://unintended-endpoint.invalid");
    try {
      expect(() => new E2BWorkspaceProvider(options)).toThrow("E2B sandbox URL must be an HTTP(S) origin");
      expect(sdk.create).not.toHaveBeenCalled();
      expect(sdk.connect).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  test.each([
    ["http://localhost:13002/", "http://localhost:13002"],
    ["http://[::1]:13002/", "http://[::1]:13002"],
    ["https://sandbox.example.test/", "https://sandbox.example.test"],
  ])("accepts sandbox proxy origin %s and routes the selected port", async (sandboxUrl, origin) => {
    const { options, connection } = fixture({ sandboxUrl });
    const workspace = await new E2BWorkspaceProvider(options).connect("sandbox-existing");
    for (const port of [1, 4096, 65_535]) {
      expect(workspace.getProxyUrl(port)).toBe(origin);
      expect(workspace.getProxyHeaders(port)).toEqual({
        "e2b-traffic-access-token": "traffic-secret",
        "e2b-sandbox-id": "sandbox-existing",
        "e2b-sandbox-port": String(port),
      });
    }
    expect(workspace.getHost(4096)).toBe("4096-sandbox-existing.sandboxes.example.test");
    for (const port of [0, -1, 65_536, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => workspace.getProxyUrl(port)).toThrow("Sandbox port");
      expect(() => workspace.getProxyHeaders(port)).toThrow("Sandbox port");
    }
    delete connection.trafficAccessToken;
    expect(() => workspace.getProxyHeaders()).toThrow("proxy access is disabled");
  });

  test("pauses with memory and renews active workspace lifetime without a kill operation", async () => {
    const { options, pause, setTimeout } = fixture();
    const workspace = await new E2BWorkspaceProvider(options).connect("sandbox-existing");
    await workspace.renewTimeout();
    await workspace.renewTimeout(1_200_000);
    await workspace.pause();
    await workspace.pause();
    expect(setTimeout.mock.calls).toEqual([[900_000], [1_200_000]]);
    expect(pause.mock.calls).toEqual([[{ keepMemory: true }], [{ keepMemory: true }]]);
    await expect(workspace.renewTimeout(0)).rejects.toThrow("positive integer");
  });

  test("passes commands and their inputs separately and normalizes non-zero exit results", async () => {
    const { options, run } = fixture();
    const workspace = await new E2BWorkspaceProvider(options).connect("sandbox-existing");
    expect(await workspace.exec('printf "%s" "$INPUT"', {
      cwd: "/home/user/projects/123",
      user: "user",
      envs: { INPUT: "$(not-a-command)" },
    })).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });
    expect(run).toHaveBeenCalledWith('printf "%s" "$INPUT"', {
      cwd: "/home/user/projects/123",
      user: "user",
      envs: { INPUT: "$(not-a-command)" },
      timeoutMs: 60_000,
      background: false,
    });
    run.mockRejectedValueOnce(Object.assign(new Error("build failed"), {
      stdout: "Build started\n", stderr: "Type error\n", exitCode: 2,
    }));
    expect(await workspace.exec("pnpm build")).toEqual({ stdout: "Build started\n", stderr: "Type error\n", exitCode: 2 });
  });

  test("background process survives SDK disconnection and has no default command deadline", async () => {
    const { options, run, disconnect } = fixture();
    const workspace = await new E2BWorkspaceProvider(options).connect("sandbox-existing");
    expect(await workspace.start("node bridge.mjs", { cwd: "/home/user/.swarm-hive" })).toEqual({ pid: 42 });
    expect(run).toHaveBeenCalledWith("node bridge.mjs", {
      cwd: "/home/user/.swarm-hive", background: true, timeoutMs: 0,
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test("keeps file contents and successful command output unchanged", async () => {
    const { options, read, write, run } = fixture();
    const workspace = await new E2BWorkspaceProvider(options).connect("sandbox-existing");
    await workspace.writeFile("/home/user/project.json", '{"notes":"untouched"}');
    expect(write).toHaveBeenCalledWith("/home/user/project.json", '{"notes":"untouched"}', { user: "user" });
    expect(await workspace.readFile("/home/user/project.json")).toBe("# project state\n");
    expect(read).toHaveBeenCalledWith("/home/user/project.json", { user: "user" });
    run.mockResolvedValueOnce({ stdout: "TOKEN=example-in-a-source-file", stderr: "", exitCode: 0 });
    expect((await workspace.exec("read example source")).stdout).toBe("TOKEN=example-in-a-source-file");
  });

  test("provides server-only proxy credentials and validates ports", async () => {
    const { options, connection } = fixture();
    const workspace = await new E2BWorkspaceProvider(options).connect("sandbox-existing");
    expect(workspace.getHost(4096)).toBe("4096-sandbox-existing.sandboxes.example.test");
    expect(workspace.getProxyUrl(4096)).toBe("https://4096-sandbox-existing.sandboxes.example.test");
    expect(workspace.getProxyHeaders()).toEqual({ "e2b-traffic-access-token": "traffic-secret" });
    expect(workspace.getProxyHeaders(8080)).toEqual({ "e2b-traffic-access-token": "traffic-secret" });
    for (const port of [0, -1, 65_536, Number.NaN, 1.5]) {
      expect(() => workspace.getHost(port)).toThrow("Sandbox port");
      expect(() => workspace.getProxyUrl(port)).toThrow("Sandbox port");
      expect(() => workspace.getProxyHeaders(port)).toThrow("Sandbox port");
    }
    delete connection.trafficAccessToken;
    expect(() => workspace.getProxyHeaders()).toThrow("proxy access is disabled");
  });

  test("redacts API errors and never propagates the credential-bearing cause", async () => {
    const { options, sdk } = fixture({ envs: { GITLAB_TOKEN: "gitlab-secret" } });
    sdk.create.mockRejectedValueOnce(new Error("Request e2b-secret failed: gitlab-secret Authorization: Bearer auth-secret"));
    try {
      await new E2BWorkspaceProvider(options).create("project-123");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(E2BWorkspaceError);
      expect(String(error)).not.toMatch(/e2b-secret|gitlab-secret|auth-secret/);
      expect(String(error)).toContain("[REDACTED]");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  test("redacts command environment secrets from transport errors", async () => {
    const { options, run } = fixture();
    const workspace = await new E2BWorkspaceProvider(options).connect("sandbox-existing");
    run.mockRejectedValueOnce(new Error("Bad token command-secret, traffic-secret, e2b-secret"));
    await expect(workspace.exec("node bridge.mjs", { envs: { BRIDGE_TOKEN: "command-secret" } }))
      .rejects.toThrow("Bad token [REDACTED], [REDACTED], [REDACTED]");
  });

  test("never leaks even a partial uploaded credential file in an error", async () => {
    const { options, write } = fixture();
    const workspace = await new E2BWorkspaceProvider(options).connect("sandbox-existing");
    write.mockRejectedValueOnce(new Error("Failed payload fragment: secret-persisted-in-file"));
    await expect(workspace.writeFile("/home/user/auth.json", '{"credential":"secret-persisted-in-file"}'))
      .rejects.toThrow("E2B writeFile failed; check sandbox availability and file permissions");
  });
});
