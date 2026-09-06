import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SdkClient, SdkHttpError } from "../src/native/client.js";
import type { NativeEvents, SdkInput } from "../src/contracts/native.js";

// An executable SDK stand-in verifies the actual uploaded host without model calls.
const fakeSdk = String.raw`
import { appendFileSync } from "node:fs";
const trace = (entry) => appendFileSync(process.env.SDK_TEST_TRACE, JSON.stringify(entry) + "\n");
export class Codex {
  constructor(options) {
    trace({ kind:"constructor", keys:Object.keys(options), path:options.codexPathOverride,
      leakedKeys:Object.keys(options.env).filter(key => /^(NATIVE_|E2B_)/.test(key)),
      retained:options.env.SDK_TEST_RETAIN, codexHome:options.env.CODEX_HOME });
  }
  startThread(options) { trace({kind:"start",options}); return this.thread(undefined); }
  resumeThread(id,options) { trace({kind:"resume",id,options}); return this.thread(id); }
  thread(id) {
    return { runStreamed:async (input,options) => {
      trace({kind:"run",input,keys:Object.keys(options),signal:options.signal instanceof AbortSignal});
      return {events:(async function*() {
        if (options.signal.aborted) throw new Error("already aborted");
        if (input === "throw-before-start") throw new Error("private sdk-test-secret-do-not-leak");
        yield {type:"thread.started",thread_id:id ?? "native-thread/from-sdk",extra:{native:true}};
        yield {type:"turn.started"};
        if (input === "hold") {
          yield {type:"item.started",item:{id:"native-item-pending",type:"command_execution",command:"sleep",aggregated_output:"",status:"in_progress"}};
          await new Promise((resolve,reject) => {
            if (options.signal.aborted) reject(new Error("aborted"));
            else options.signal.addEventListener("abort",() => setTimeout(() => reject(new Error("aborted")),250),{once:true});
            // Keep the fake process alive exactly like a running CLI subprocess.
            const timer = setInterval(() => {},1000);
            options.signal.addEventListener("abort",() => clearInterval(timer),{once:true});
          });
        }
        if (input === "late") await new Promise(resolve => setTimeout(resolve,100));
        if (input === "reconnecting") yield {type:"error",message:"Reconnecting... 1/5"};
        if (input === "fail") {yield {type:"turn.failed",error:{message:"native failure"}};return;}
        if (input === "no-completion") return;
        if (input === "many") for(let i=0;i<1100;i++) yield {type:"future.sdk.event",index:i,nested:{preserve:[i,null,true]}};
        yield {type:"item.updated",item:{id:"future/native:item-9",type:"future_image",content:[{type:"image",data:"unchanged-image"}],extra:{nested:[1,"raw"]}}};
        yield {type:"item.completed",item:{id:"native-item-1",type:"agent_message",text:typeof input === "string" ? input : JSON.stringify(input)}};
        yield {type:"turn.completed",usage:{input_tokens:12,cached_input_tokens:1,cache_write_input_tokens:0,output_tokens:3,reasoning_output_tokens:1}};
      })()};
    }};
  }
}
`;

const temporaryDirs: string[] = [];
const processes = new Set<ChildProcess>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor<T>(fn: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await fn();
    if (value !== undefined) return value;
    await pause(20);
  }
  throw new Error("Timed out waiting for SDK host fixture");
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) { processes.delete(child); return; }
  const exit = once(child, "exit");
  child.kill(signal);
  await exit;
  processes.delete(child);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "swarm-sdk-host-"));
  temporaryDirs.push(directory);
  const sdkPath = join(directory, "fake-sdk.mjs");
  const tokenPath = join(directory, "token");
  const tracePath = join(directory, "trace.jsonl");
  const stateDir = join(directory, "state");
  const token = randomUUID() + randomUUID();
  const port = await freePort();
  await writeFile(sdkPath, fakeSdk, { mode: 0o600 });
  await writeFile(tokenPath, token, { mode: 0o600 });
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = new SdkClient({ baseUrl, token });
  const env = { ...process.env, NATIVE_STATE_DIR: stateDir, NATIVE_TOKEN_FILE: tokenPath,
    NATIVE_CWD: directory, NATIVE_PORT: String(port), NATIVE_SDK_MODULE: sdkPath,
    NATIVE_CODEX_PATH: "/fixture/native-codex", NATIVE_TEST_SECRET: "must-not-inherit",
    E2B_API_KEY: "must-not-inherit", SDK_TEST_TRACE: tracePath, SDK_TEST_RETAIN: "retained-value",
    CODEX_HOME: join(directory,"native-codex-home") };
  async function start() {
    const child = spawn(process.execPath, [resolve("src/native/sdk-host.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    processes.add(child);
    let output = "";
    child.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { output += data.toString(); });
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`SDK host exited: ${output}`);
      try { return await client.health(); } catch { return undefined; }
    });
    return { child, output: () => output };
  }
  const running = await start();
  async function traces(): Promise<Array<Record<string, unknown>>> {
    try { return (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function finished(requestId: string): Promise<NativeEvents> {
    return waitFor(async () => {
      const data = await client.events();
      const health = await client.health();
      return data.runs.find((run) => run.requestId === requestId && run.status !== "running") && health.activeRequestId !== requestId ? data : undefined;
    });
  }
  return { ...running, directory, stateDir, tracePath, tokenPath, token, baseUrl, client, start, traces, finished };
}

afterEach(async () => {
  await Promise.all([...processes].map((child) => stop(child, "SIGKILL")));
  await Promise.all(temporaryDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("official SDK host", () => {
  it("passes SDK inputs, events, native IDs and default configuration through unchanged", async () => {
    const f = await fixture();
    const input: SdkInput = [{ type: "text", text: "  原样输入\n，不加项目 wrapper。" }, { type: "local_image", path: "./image a.png" }];
    const requestId = randomUUID();
    expect(await f.client.run({ requestId, input })).toMatchObject({ requestId, input, status: "running", threadId: null });
    const result = await f.finished(requestId);
    expect(result.runs[0]).toMatchObject({ threadId: "native-thread/from-sdk", status: "completed", input });
    expect(result.events.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(result.events.every((entry) => entry.requestId === requestId)).toBe(true);
    expect(result.events[0]?.event).toEqual({ type: "thread.started", thread_id: "native-thread/from-sdk", extra: { native: true } });
    expect(result.events[2]?.event).toEqual({ type: "item.updated", item: { id: "future/native:item-9", type: "future_image", content: [{ type: "image", data: "unchanged-image" }], extra: { nested: [1, "raw"] } } });
    const traces = await f.traces();
    expect(traces[0]).toEqual({kind:"constructor",keys:["codexPathOverride","env"],path:"/fixture/native-codex",leakedKeys:[],retained:"retained-value",codexHome:join(f.directory,"native-codex-home")});
    expect(traces[1]).toEqual({ kind: "start", options: { workingDirectory: f.directory, skipGitRepoCheck: true } });
    expect(traces[2]).toEqual({ kind: "run", input, keys: ["signal"], signal: true });
    expect(f.output()).toBe("");
    expect((await stat(f.stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.stateDir,"runs.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.stateDir,"sdk-events.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("resumes the actual SDK-produced thread ID for a second turn with exact latest text", async () => {
    const f = await fixture();
    const firstId = randomUUID();
    await f.client.run({ requestId: firstId, input: "first" });
    const first = await f.finished(firstId);
    const threadId = first.runs[0]!.threadId!;
    const secondId = randomUUID();
    await f.client.run({ requestId: secondId, input: "现在创建 mr 了吗？", threadId });
    const second = await f.finished(secondId);
    expect(second.runs[1]).toMatchObject({ threadId, input: "现在创建 mr 了吗？", status: "completed" });
    expect((await f.traces()).filter((entry) => entry.kind === "resume")).toEqual([{ kind: "resume", id: threadId, options: { workingDirectory: f.directory, skipGitRepoCheck: true } }]);
    expect((await f.traces()).filter((entry) => entry.kind === "run").map((entry) => entry.input)).toEqual(["first", "现在创建 mr 了吗？"]);
    await stop(f.child);
    await f.start();
    expect(await f.client.run({ requestId: secondId, input: "现在创建 mr 了吗？", threadId })).toEqual(second.runs[1]);
    await expect(f.client.run({ requestId: secondId, input: "现在创建 mr 了吗？" })).rejects.toMatchObject({ status: 409 });
    expect((await f.traces()).filter((entry) => entry.kind === "run")).toHaveLength(2);
  });

  it("rejects concurrent submissions, deduplicates IDs and interrupts without inventing native events", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    await f.client.run({ requestId, input: "hold" });
    await waitFor(async () => (await f.client.events()).events.length >= 3 ? true : undefined);
    expect((await f.client.health()).activeRequestId).toBe(requestId);
    await expect(f.client.run({ requestId: randomUUID(), input: "do not queue" })).rejects.toMatchObject({ status: 409 });
    await expect(f.client.run({ requestId, input: "duplicate must not replace original" })).rejects.toMatchObject({ status: 409 });
    await expect(f.client.run({ requestId, input: "hold", threadId: "different-thread" })).rejects.toMatchObject({ status: 409 });
    expect((await f.client.run({ requestId, input: "hold" })).input).toBe("hold");
    expect(await f.client.interrupt(requestId)).toMatchObject({ requestId, status: "running", error: expect.stringMatching(/waiting for the SDK/) });
    expect((await f.client.health()).activeRequestId).toBe(requestId);
    await expect(f.client.run({ requestId: randomUUID(), input: "SDK has not stopped yet" })).rejects.toMatchObject({ status: 409 });
    const result = await f.finished(requestId);
    expect(result.events.map((entry) => entry.event.type)).toEqual(["thread.started", "turn.started", "item.started"]);
    expect((await f.traces()).filter((entry) => entry.kind === "run")).toHaveLength(1);
    expect(await f.client.interrupt(requestId)).toMatchObject({ status: "interrupted" });
  });

  it("retains active execution when the submitting browser disconnects and reconnects by cursor", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const response = await fetch(`${f.baseUrl}/runs`, { method: "POST", headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId, input: "late" }) });
    expect(response.status).toBe(202);
    await response.body?.cancel();
    const firstPage = await f.client.events(0, 1);
    const complete = await f.finished(requestId);
    const newClient = new SdkClient({ baseUrl: f.baseUrl, token: f.token });
    const remaining = await newClient.events(firstPage.nextAfter);
    expect([...firstPage.events, ...remaining.events]).toEqual(complete.events);
    expect(complete.runs[0]?.status).toBe("completed");
  });

  it("restores user input and raw history, marks interrupted outcome unknown and never automatically replays", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const oldInstance = (await f.client.health()).instanceId;
    await f.client.run({ requestId, input: "hold" });
    await waitFor(async () => (await f.client.events()).events.length >= 3 ? true : undefined);
    const before = await f.client.events();
    await stop(f.child, "SIGKILL");
    // Reproduce a crash between journaling thread.started and saving its metadata.
    const metadata = JSON.parse(await readFile(join(f.stateDir, "runs.json"), "utf8")) as Array<Record<string, unknown>>;
    metadata[0]!.threadId = null;
    await writeFile(join(f.stateDir, "runs.json"), JSON.stringify(metadata));
    await appendFile(join(f.stateDir, "sdk-events.jsonl"), '{"seq":4,"torn":');
    await f.start();
    const restored = await f.client.events();
    expect(restored.instanceId).not.toBe(oldInstance);
    expect(restored.events).toEqual(before.events);
    expect(restored.runs[0]).toMatchObject({ input: "hold", status: "interrupted", threadId: "native-thread/from-sdk" });
    expect(restored.runs[0]?.error).toMatch(/outcome is unknown/);
    expect((await f.client.health()).activeRequestId).toBeNull();
    expect(await f.client.run({ requestId, input: "hold" })).toEqual(restored.runs[0]);
    expect((await f.traces()).filter((entry) => entry.kind === "run")).toHaveLength(1);
    const nextId = randomUUID();
    await f.client.run({ requestId: nextId, input: "continue", threadId: restored.runs[0]!.threadId! });
    const done = await f.finished(nextId);
    expect(done.events[3]?.seq).toBe(4);
    expect(done.runs[1]?.status).toBe("completed");
  });

  it("preserves completed-run idempotency over host restart", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    await f.client.run({ requestId, input: "finished" });
    const before = await f.finished(requestId);
    await stop(f.child);
    await f.start();
    expect(await f.client.run({ requestId, input: "finished" })).toEqual(before.runs[0]);
    await expect(f.client.run({ requestId, input: "different" })).rejects.toMatchObject({ status: 409 });
    await expect(f.client.run({ requestId, input: "finished", threadId: "different-thread" })).rejects.toMatchObject({ status: 409 });
    expect((await f.client.events()).events).toEqual(before.events);
    expect((await f.traces()).filter((entry) => entry.kind === "run")).toHaveLength(1);
  });

  it("reports SDK failures without inventing native completion or exposing private stderr", async () => {
    const f = await fixture();
    for (const input of ["fail", "no-completion", "throw-before-start"]) {
      const requestId = randomUUID();
      await f.client.run({ requestId, input });
      const result = await f.finished(requestId);
      const run = result.runs.find((entry) => entry.requestId === requestId)!;
      expect(run.status).toBe("failed");
      expect(JSON.stringify(run)).not.toContain("sdk-test-secret");
      expect(result.events.filter((entry) => entry.requestId === requestId).some((entry) => entry.event.type === "turn.completed")).toBe(false);
      if (input === "throw-before-start") expect(run.threadId).toBeNull();
    }
    expect(f.output()).toBe("");
    expect(await readFile(join(f.stateDir, "sdk-errors.log"), "utf8")).toContain("private sdk-test-secret-do-not-leak");
    expect((await stat(join(f.stateDir, "sdk-errors.log"))).mode & 0o777).toBe(0o600);
  });

  it("keeps transient SDK errors intact but accepts the eventual successful native completion", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    await f.client.run({ requestId, input: "reconnecting" });
    const result = await f.finished(requestId);
    expect(result.events.map((entry) => entry.event.type)).toContain("error");
    expect(result.events.find((entry) => entry.event.type === "error")?.event).toEqual({ type: "error", message: "Reconnecting... 1/5" });
    expect(result.events.at(-1)?.event.type).toBe("turn.completed");
    expect(result.runs[0]?.status).toBe("completed");
    expect(result.runs[0]?.error).toBeUndefined();
  });

  it("paginates durable events after the bounded hot cache has rolled over", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    await f.client.run({ requestId, input: "many" });
    await f.finished(requestId);
    const first = await f.client.events(0, 500);
    const second = await f.client.events(first.nextAfter, 500);
    const third = await f.client.events(second.nextAfter, 500);
    const events = [...first.events, ...second.events, ...third.events];
    expect(events).toHaveLength(1105);
    expect(events.map((entry) => entry.seq)).toEqual(Array.from({ length: 1105 }, (_, index) => index + 1));
    expect(events[1000]?.event).toEqual({ type: "future.sdk.event", index: 998, nested: { preserve: [998, null, true] } });
    expect(await f.client.events(third.nextAfter)).toMatchObject({ events: [], nextAfter: 1105 });
  });

  it("authenticates all endpoints and rejects wrong HTTP methods, invalid SDK input and oversized bodies", async () => {
    const f = await fixture();
    for (const path of ["/health", "/events", "/runs", `/runs/${randomUUID()}/interrupt`, "/unknown"]) {
      expect((await fetch(`${f.baseUrl}${path}`)).status).toBe(401);
    }
    const headers = { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" };
    expect((await fetch(`${f.baseUrl}/health`, { method: "POST", headers, body: "{}" })).status).toBe(405);
    expect((await fetch(`${f.baseUrl}/health`, { headers: { ...headers, Origin: "https://attacker.invalid" } })).status).toBe(403);
    expect((await fetch(`${f.baseUrl}/events?after=-1`, { headers })).status).toBe(400);
    expect((await fetch(`${f.baseUrl}/rpc`, { method: "POST", headers, body: "{}" })).status).toBe(404);
    for (const body of ["{", "[]", JSON.stringify({ requestId: "not-a-uuid", input: "x" }), JSON.stringify({ requestId: randomUUID(), input: [{ type: "image", data: "not SDK input" }] }), JSON.stringify({ requestId: randomUUID(), input: "x", model: "injected" })]) {
      expect((await fetch(`${f.baseUrl}/runs`, { method: "POST", headers, body })).status).toBe(400);
    }
    expect((await fetch(`${f.baseUrl}/runs`, { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), input: "x".repeat(1024 * 1024) }) })).status).toBe(413);
    expect((await f.traces()).length).toBe(0);
  });
});

describe("SDK HTTP client", () => {
  it("preserves proxy headers, never retries a mutation and keeps ambiguous outcomes explicit", async () => {
    let calls = 0;
    const client = new SdkClient({ baseUrl: "https://sandbox.example", token: "private-bearer-token", headers: { "e2b-access-token": "proxy-token" }, fetchImplementation: (async (_url: unknown, options: RequestInit) => {
      calls++;
      const headers = new Headers(options.headers);
      expect(headers.get("Authorization")).toBe("Bearer private-bearer-token");
      expect(headers.get("e2b-access-token")).toBe("proxy-token");
      expect(options.redirect).toBe("error");
      throw new Error("transport private-bearer-token");
    }) as typeof fetch });
    await expect(client.run({ requestId: randomUUID(), input: "one" })).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/outcome is unknown/) });
    expect(calls).toBe(1);
  });

  it("exposes HTTP status without reflecting arbitrary proxy secrets and handles truncated success JSON", async () => {
    const failing = new SdkClient({ baseUrl: "https://sandbox.example", token: "secret", fetchImplementation: (async () => new Response("<html>secret credentials</html>", { status: 409 })) as typeof fetch });
    await expect(failing.run({ requestId: randomUUID(), input: "one" })).rejects.toEqual(new SdkHttpError("SDK host HTTP 409", 409));
    const truncated = new SdkClient({ baseUrl: "https://sandbox.example", token: "secret", fetchImplementation: (async () => new Response("{")) as typeof fetch });
    await expect(truncated.run({ requestId: randomUUID(), input: "one" })).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/outcome is unknown/) });
  });
});
