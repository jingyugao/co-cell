import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, createReadStream, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Transport task IDs and native Codex thread IDs are deliberately separate.
// The SDK owns the conversation, configuration, tools and model execution.
async function main() {
  const stateDir = process.env.NATIVE_STATE_DIR;
  const tokenPath = process.env.NATIVE_TOKEN_FILE;
  const cwd = process.env.NATIVE_CWD;
  const sdkModule = process.env.NATIVE_SDK_MODULE;
  if (!stateDir || !tokenPath || !cwd || !sdkModule) throw new Error("SDK host paths are required");
  const token = readFileSync(tokenPath, "utf8").trim();
  if (token.length < 32) throw new Error("SDK host token must contain at least 32 characters");
  chmodSync(tokenPath, 0o600);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const port = Number(process.env.NATIVE_PORT || 4097);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SDK host port");
  const instanceId = randomUUID();
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const runsPath = join(stateDir, "runs.json");
  const journalPath = join(stateDir, "sdk-events.jsonl");
  const errorPath = join(stateDir, "sdk-errors.log");
  const bodyLimit = 1024 * 1024;
  const pageByteLimit = 8 * 1024 * 1024;
  const runs = new Map();
  const requestedThreads = new Map();
  const hot = [];
  let hotBytes = 0;
  let sequence = 0;
  let ready = false;
  let stopping = false;
  let active = null;
  let Codex;
  let journalFd;
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const validInput = (value) => typeof value === "string" || (Array.isArray(value) && value.every((item) => object(item) && (
    (item.type === "text" && typeof item.text === "string") || (item.type === "local_image" && typeof item.path === "string")
  )));

  function saveRuns() {
    const temporaryPath = join(stateDir, `runs.${instanceId}.tmp`);
    const fd = openSync(temporaryPath, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify([...runs.values()].map((run) => ({ ...run, requestedThreadId: requestedThreads.get(run.requestId) ?? null })))); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporaryPath, runsPath);
    const directory = openSync(stateDir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  function privateError(error) {
    // SDK subprocess stderr can contain credentials. Never send it to public logs.
    try { appendFileSync(errorPath, `${new Date().toISOString()} ${String(error?.stack || error)}\n`, { mode: 0o600 }); chmodSync(errorPath, 0o600); }
    catch { /* The generic HTTP error remains sufficient if the private disk fails. */ }
  }
  function remember(event, bytes) {
    hot.push({ event, bytes }); hotBytes += bytes;
    while (hot.length > 1000 || (hot.length > 1 && hotBytes > pageByteLimit)) hotBytes -= hot.shift().bytes;
  }
  function journal(requestId, nativeEvent) {
    const event = { seq: sequence + 1, requestId, event: nativeEvent };
    const line = JSON.stringify(event) + "\n";
    // Save raw SDK events, including unknown future event/item types.
    try { writeFileSync(journalFd, line); fsyncSync(journalFd); }
    catch (error) { ready = false; throw error; }
    sequence = event.seq;
    remember(event, Buffer.byteLength(line));
  }
  async function restore() {
    appendFileSync(journalPath, "", { mode: 0o600 }); chmodSync(journalPath, 0o600);
    let completeBytes = 0;
    let tail = Buffer.alloc(0);
    const nativeThreadIds = new Map();
    for await (const chunk of createReadStream(journalPath)) {
      tail = Buffer.concat([tail, chunk]);
      let newline;
      while ((newline = tail.indexOf(10)) !== -1) {
        const event = JSON.parse(tail.subarray(0, newline).toString("utf8"));
        if (!object(event) || !Number.isSafeInteger(event.seq) || event.seq <= sequence || !uuid(event.requestId) || !object(event.event)) throw new Error("Invalid SDK journal");
        if (event.event.type === "thread.started" && typeof event.event.thread_id === "string") nativeThreadIds.set(event.requestId, event.event.thread_id);
        sequence = event.seq; remember(event, newline + 1); completeBytes += newline + 1;
        tail = tail.subarray(newline + 1);
      }
    }
    // Only a torn final append is repaired; completed native records stay intact.
    if (statSync(journalPath).size !== completeBytes) truncateSync(journalPath, completeBytes);
    journalFd = openSync(journalPath, "a", 0o600);
    let saved = [];
    try { saved = JSON.parse(readFileSync(runsPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!Array.isArray(saved)) throw new Error("Invalid SDK runs metadata");
    for (const savedRun of saved) {
      const { requestedThreadId, ...run } = savedRun;
      if (!object(run) || !uuid(run.requestId) || !validInput(run.input) || !["running", "completed", "failed", "interrupted"].includes(run.status)) throw new Error("Invalid SDK run");
      // A crash can occur after the native event fsync and before metadata rename.
      if (nativeThreadIds.has(run.requestId)) run.threadId = nativeThreadIds.get(run.requestId);
      if (run.status === "running") {
        run.status = "interrupted";
        run.error = "SDK host restarted while running; execution outcome is unknown. Verify before starting another run.";
      }
      runs.set(run.requestId, run);
      requestedThreads.set(run.requestId, requestedThreadId ?? null);
    }
    saveRuns();
  }
  async function readEvents(after, limit) {
    const lastSequence = sequence;
    const page = [];
    let bytes = 0;
    const accept = (event) => {
      if (event.seq <= after || event.seq > lastSequence) return true;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (page.length >= limit || (page.length > 0 && bytes + size > pageByteLimit)) return false;
      page.push(event); bytes += size; return true;
    };
    if (!hot.length || after >= hot[0].event.seq - 1) {
      for (const entry of hot) if (!accept(entry.event)) break;
    } else {
      const input = createReadStream(journalPath, { end: statSync(journalPath).size - 1 });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try { for await (const line of lines) if (line && !accept(JSON.parse(line))) break; }
      finally { lines.close(); input.destroy(); }
    }
    return { instanceId, events: page, nextAfter: page.at(-1)?.seq ?? after, runs: [...runs.values()] };
  }
  async function execute(run, requestedThreadId, control) {
    let completed = false;
    let failed = false;
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NATIVE_") && !key.startsWith("E2B_")));
      const codex = new Codex({ codexPathOverride: process.env.NATIVE_CODEX_PATH || "codex", env });
      const options = { workingDirectory: cwd, skipGitRepoCheck: true };
      const thread = requestedThreadId === undefined ? codex.startThread(options) : codex.resumeThread(requestedThreadId, options);
      const { events } = await thread.runStreamed(run.input, { signal: control.signal });
      for await (const event of events) {
        journal(run.requestId, event);
        if (event.type === "thread.started" && typeof event.thread_id === "string") { run.threadId = event.thread_id; saveRuns(); }
        if (event.type === "turn.completed") completed = true;
        // Diagnostic error events can report reconnects that recover. The native
        // terminal failure, not an intermediate diagnostic, determines failure.
        if (event.type === "turn.failed") failed = true;
      }
      if (!control.signal.aborted) {
        run.status = completed && !failed ? "completed" : "failed";
        if (run.status === "failed") run.error = failed ? "Codex reported an execution failure; inspect SDK events." : "SDK stream ended without a completion event; execution outcome is unknown.";
      }
    } catch (error) {
      privateError(error);
      if (!control.signal.aborted) { run.status = "failed"; run.error = "SDK execution failed; inspect the private sdk-errors.log. Execution outcome may be unknown."; }
    } finally {
      if (control.signal.aborted) { run.status = "interrupted"; run.error = "SDK run interrupted; verify any in-flight external actions before retrying."; }
      try { saveRuns(); }
      catch (error) { ready = false; privateError(error); }
      if (active?.run === run) active = null;
    }
  }
  function reply(response, status, body) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify(body));
  }
  function readBody(incoming) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      const timer = setTimeout(() => fail(408, "Request body timed out"), 10_000);
      const cleanup = () => { clearTimeout(timer); incoming.off("data", data); incoming.off("end", end); incoming.off("error", error); incoming.off("aborted", error); };
      const fail = (statusCode, message) => { cleanup(); incoming.resume(); reject(Object.assign(new Error(message), { statusCode })); };
      const data = (chunk) => { size += chunk.length; if (size > bodyLimit) fail(413, "Request exceeds 1 MiB"); else chunks.push(chunk); };
      const end = () => {
        cleanup();
        try { const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!object(body)) throw new Error(); resolve(body); }
        catch { reject(Object.assign(new Error("Expected a JSON object"), { statusCode: 400 })); }
      };
      const error = () => fail(400, "Request body interrupted");
      incoming.on("data", data); incoming.on("end", end); incoming.on("error", error); incoming.on("aborted", error);
    });
  }
  const server = createServer(async (incoming, response) => {
    try {
      const authorization = Buffer.from(incoming.headers.authorization || "");
      if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) { reply(response, 401, { error: "Unauthorized" }); return; }
      if (incoming.headers.origin) { reply(response, 403, { error: "Use the authenticated backend proxy" }); return; }
      const url = new URL(incoming.url || "/", "http://sdk-host.invalid");
      const interruptMatch = /^\/runs\/([0-9a-f-]+)\/interrupt$/i.exec(url.pathname);
      const expectedMethod = url.pathname === "/health" || url.pathname === "/events" ? "GET" : url.pathname === "/runs" || interruptMatch ? "POST" : null;
      if (!expectedMethod) { reply(response, 404, { error: "Not found" }); return; }
      if (incoming.method !== expectedMethod) { reply(response, 405, { error: "Method not allowed" }); return; }
      if (!ready || stopping) { reply(response, 503, { error: "SDK host is not ready" }); return; }
      if (url.pathname === "/health") { reply(response, 200, { status: "ready", instanceId, activeRequestId: active?.run.requestId ?? null }); return; }
      if (url.pathname === "/events") {
        const after = Number(url.searchParams.get("after") || 0), limit = Number(url.searchParams.get("limit") || 200);
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) { reply(response, 400, { error: "Invalid event pagination" }); return; }
        reply(response, 200, await readEvents(after, limit)); return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(incoming.headers["content-type"] || "")) { reply(response, 415, { error: "Expected application/json" }); return; }
      const body = await readBody(incoming);
      if (interruptMatch) {
        if (!uuid(interruptMatch[1]) || Object.keys(body).length) { reply(response, 400, { error: "Expected an empty object and a UUID submission ID" }); return; }
        const run = runs.get(interruptMatch[1]);
        if (!run) { reply(response, 404, { error: "Submission not found" }); return; }
        if (active?.run === run) {
          run.error = "Interruption requested; waiting for the SDK execution to stop.";
          saveRuns(); active.control.abort();
        }
        reply(response, 200, run); return;
      }
      if (!uuid(body.requestId) || !validInput(body.input) || (body.threadId !== undefined && (typeof body.threadId !== "string" || !body.threadId)) || Object.keys(body).some((key) => !["requestId", "input", "threadId"].includes(key))) {
        reply(response, 400, { error: "Expected requestId UUID, SDK input, and optional native threadId" }); return;
      }
      const previous = runs.get(body.requestId);
      if (previous) {
        if (!isDeepStrictEqual(previous.input, body.input) || requestedThreads.get(body.requestId) !== (body.threadId ?? null)) {
          reply(response, 409, { error: "Submission ID already belongs to a different input or thread" }); return;
        }
        reply(response, 200, previous); return;
      }
      if (active) { reply(response, 409, { error: "A run is already active; wait for completion or interrupt it" }); return; }
      const run = { requestId: body.requestId, threadId: null, input: body.input, status: "running", createdAt: new Date().toISOString() };
      const control = new AbortController();
      runs.set(run.requestId, run);
      requestedThreads.set(run.requestId, body.threadId ?? null);
      active = { run, control };
      try { saveRuns(); }
      catch (error) { runs.delete(run.requestId); requestedThreads.delete(run.requestId); active = null; throw error; }
      reply(response, 202, run);
      // The task belongs to the host, never to a browser's HTTP connection.
      setImmediate(() => { void execute(run, body.threadId, control); });
    } catch (error) {
      if (!error.statusCode) privateError(error);
      reply(response, error.statusCode || 500, { error: error.statusCode ? error.message : "SDK host failed; execution outcome may be unknown" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  // Claim the single-owner port before reading or changing durable run metadata.
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
  try { await restore(); ({ Codex } = await import(pathToFileURL(sdkModule).href)); if (typeof Codex !== "function") throw new Error("Invalid SDK module"); ready = true; }
  catch (error) { privateError(error); server.close(); throw new Error("SDK host initialization failed"); }
  function shutdown() {
    if (stopping) return;
    stopping = true;
    if (active) {
      active.run.status = "interrupted";
      active.run.error = "SDK host stopped during execution; outcome may be unknown.";
      try { saveRuns(); } catch (error) { privateError(error); }
      active.control.abort();
    }
    server.close();
    server.closeIdleConnections();
    const deadline = setTimeout(() => process.exit(0), 2000); deadline.unref();
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch(() => { process.stderr.write("Unable to start SDK host; inspect its private state directory.\n"); process.exitCode = 1; });
