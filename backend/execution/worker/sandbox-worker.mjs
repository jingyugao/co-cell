import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startImprovementBridge } from './improvement-bridge.mjs';
import { startApprovalBridge } from './approval-bridge.mjs';

// The private input file carries prompts and configuration, never shell arguments.
async function main() {
const inputPath = process.argv[2];
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const { Codex } = await import(input.agentcorePath
  ? pathToFileURL(input.agentcorePath).href
  : new URL('../../../packages/agentcore/src/index.mjs', import.meta.url).href);
await unlink(inputPath);
const runDirectory = input.runDirectory;
const journalPath = `${runDirectory}/events.jsonl`;
const statePath = `${runDirectory}/state.json`;
let sequence = 0;
let actualThreadId = input.threadId ?? null;
let lifecycle = 'running';
let terminalError;
let journalError;
let publishing = Promise.resolve();
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
await writeFile(journalPath, '', { mode: 0o600 });
async function writeState() {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({
    protocolVersion: 1, workerId: input.workerId, sessionId: input.sessionId,
    turnId: input.turnId, pid: process.pid, status: lifecycle,
    threadId: actualThreadId, lastSeq: sequence, error: terminalError,
    updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  await rename(temporary, statePath);
}
function publish(event) {
  const operation = publishing.then(async () => {
    if (journalError) throw journalError;
    if (event.type === 'thread.started') actualThreadId = event.thread_id;
    if (event.type === 'turn.completed') lifecycle = 'completed';
    else if (event.type === 'turn.failed') { lifecycle = 'failed'; terminalError = event.error?.message; }
    const envelope = { v: 1, workerId: input.workerId, turnId: input.turnId,
      seq: sequence + 1, at: new Date().toISOString(), event };
    await appendFile(journalPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    sequence = envelope.seq;
    await writeState();
  });
  publishing = operation.catch(error => { journalError ??= error; controller.abort(); });
  return operation;
}
const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
let codex;
let improvementBridge;
let approvalBridge;
try {
  await publish({ type: 'runtime.worker_started' });
  const extra = input.modelConfig ?? {};
  if (input.improvementReplyDirectory) {
    improvementBridge = await startImprovementBridge({
      replyDirectory: input.improvementReplyDirectory, signal: controller.signal,
      emit: publish,
    });
  }
  if (input.approvalReplyDirectory) {
    approvalBridge = await startApprovalBridge({
      replyDirectory: input.approvalReplyDirectory, signal: controller.signal,
      emit: publish,
    });
  }
  codex = new Codex({
    codexPathOverride: input.codexPath ?? '/home/user/.codex-web/runtime/node_modules/.bin/codex',
    apiKey: process.env.CODEX_API_KEY,
    config: { ...extra,
      ...((improvementBridge || approvalBridge) ? {
        mcp_servers: { ...extra.mcp_servers,
          ...(improvementBridge ? { swarm_improvements: improvementBridge.config } : {}),
          ...(approvalBridge ? { swarm_approvals: approvalBridge.config } : {}),
        },
      } : {}),
    },
    configOverrides: input.configOverrides ?? [],
  });
  const { settings } = input;
  const options = {
    workingDirectory: settings.workingDirectory,
    ...(settings.model ? { model: settings.model } : {}),
    modelReasoningEffort: settings.modelReasoningEffort,
    // Explicit App Server sandbox policy overrides persisted thread settings;
    // The container is the execution boundary, including for user-level caches.
    sandboxMode: 'danger-full-access',
    webSearchMode: settings.webSearchMode,
    networkAccessEnabled: true,
    approvalPolicy: 'never', skipGitRepoCheck: true,
    additionalDirectories: input.connectionDirectories ?? [],
  };
  const thread = input.threadId ? codex.resumeThread(input.threadId, options) : codex.startThread(options);
  const prompt = input.images.length
    ? [{ type: 'text', text: input.prompt }, ...input.images.map(path => ({ type: 'local_image', path }))]
    : input.prompt;
  const { events } = await thread.runStreamed(prompt, { signal: controller.signal });
  for await (const event of events) {
    // Protocol errors can omit HTTP bodies (notably 429) or stream disconnect causes.
    // Attach the current request's sanitized diagnostic before journaling it.
    await publish(event);
  }
  await publishing;
  if (!['completed', 'failed'].includes(lifecycle)) throw new Error('Codex event stream ended without a terminal event');
} catch (error) {
  const cause = journalError ?? error;
  let message = cause instanceof Error ? cause.message : String(cause);
  if (process.env.CODEX_API_KEY) message = message.replaceAll(process.env.CODEX_API_KEY, '[REDACTED]');
  message = message.slice(0, 16_384);
  lifecycle = controller.signal.aborted && !journalError ? 'cancelled' : 'failed';
  terminalError = message;
  await publish({ type: controller.signal.aborted ? 'runtime.worker_cancelled' : 'runtime.worker_failed', message }).catch(() => {});
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  try {
    await codex?.close();
    await Promise.all([improvementBridge?.close(), approvalBridge?.close()]);
  }
  finally {
    await publishing;
    await writeState().catch(() => {});
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
