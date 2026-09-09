import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import { startDiagnosticProxy } from './diagnostic-proxy.mjs';
import { startImprovementBridge } from './improvement-bridge.mjs';
import { startApprovalBridge } from './approval-bridge.mjs';

const headerEntries = headers => headers instanceof Headers ? [...headers.entries()] : Object.entries(headers ?? {});
function singleHeader(headers, name) {
  const matches = headerEntries(headers).filter(([key]) => key.toLowerCase() === name);
  return matches.length === 1 && typeof matches[0][1] === 'string' ? matches[0][1] : undefined;
}
function waitForLookup(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Resolve the completed initial request's channel. Never guess from session affinity. */
export function createSameChannelResolver({ upstreamBaseUrl, fetchImpl = fetch, onDiagnostic = () => {}, pollDelaysMs = [0, 1000, 2000], requestTimeoutMs = 2000 }) {
  const endpoint = new URL('/api/log/token', upstreamBaseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid channel lookup URL');
  const emit = record => { try { Promise.resolve(onDiagnostic(record)).catch(() => {}); } catch {} };
  return async ({ requestHeaders, responseHeaders, signal }) => {
    signal?.throwIfAborted();
    const authorization = singleHeader(requestHeaders, 'authorization');
    const auth = authorization?.match(/^(Bearer[ \t]+)([^\s]+)$/i);
    const requestId = singleHeader(responseHeaders, 'x-oneapi-request-id');
    const unresolved = reason => { emit({ event: 'api.observation', reason, ...(requestId && /^[\w-]{1,128}$/.test(requestId) ? { upstreamRequestId: requestId } : {}) }); return null; };
    if (!auth) return unresolved('retry_channel_invalid_authorization');
    if (!requestId || !/^[\w-]{1,128}$/.test(requestId)) return unresolved('retry_channel_missing_request_id');
    // New API removes the optional sk- prefix, then accepts an admin channel
    // suffix. Leave an already pinned credential byte-for-byte unchanged.
    const token = auth[2];
    const tokenParts = token.replace(/^sk-/, '').split('-');
    if (!tokenParts[0] || tokenParts.length > 2 || (tokenParts.length === 2 && !/^[1-9]\d*$/.test(tokenParts[1]))) {
      return unresolved('retry_channel_unsupported_token_format');
    }
    const existingChannel = tokenParts.length === 2 ? Number(tokenParts[1]) : undefined;
    if (existingChannel !== undefined && !Number.isSafeInteger(existingChannel)) return unresolved('retry_channel_unsupported_token_format');
    for (const delayMs of pollDelaysMs) {
      await waitForLookup(delayMs, signal);
      let response, data;
      try {
        response = await fetchImpl(endpoint, {
          method: 'GET', headers: { authorization }, redirect: 'error',
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(requestTimeoutMs)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if ([401, 403, 404].includes(response.status)) return unresolved('retry_channel_lookup_unavailable');
          continue;
        }
        data = await response.json();
      } catch {
        signal?.throwIfAborted();
        continue;
      }
      signal?.throwIfAborted();
      if (data?.success !== true || !Array.isArray(data.data)) continue;
      const matches = data.data.filter(row => row && row.request_id === requestId);
      if (!matches.length) continue;
      if (matches.some(row => !Number.isSafeInteger(row.channel) || row.channel < 1)) return unresolved('retry_channel_invalid_log_mapping');
      const channels = new Set(matches.map(row => row.channel));
      if (channels.size !== 1) return unresolved('retry_channel_conflicting_log_mapping');
      const channelId = matches[0].channel;
      if (existingChannel !== undefined && existingChannel !== channelId) return unresolved('retry_channel_pin_mismatch');
      const headers = Object.fromEntries(headerEntries(requestHeaders));
      const authKey = Object.keys(headers).find(key => key.toLowerCase() === 'authorization');
      headers[authKey] = existingChannel === undefined ? `${authorization}-${channelId}` : authorization;
      emit({ event: 'api.retry_channel_resolved', upstreamRequestId: requestId, channelId,
        pin: 'new-api-admin-token-suffix', scope: 'capacity-retry-initial-route',
        limitation: 'Upstream internal channel-error retry handling remains controlled by New API.' });
      return headers;
    }
    return unresolved('retry_channel_log_not_found');
  };
}

/** CLIProxyAPI owns upstream retries; New API needs its channel-pinning resolver. */
export function createOverloadRetryOptions({ proxyKind = 'new-api', baseUrl }, onDiagnostic) {
  if (proxyKind === 'cliproxyapi') return false;
  if (proxyKind !== 'new-api') throw new Error('Unsupported model proxy kind');
  return { resolveRetryHeaders: createSameChannelResolver({ upstreamBaseUrl: baseUrl, onDiagnostic }) };
}

// The private input file carries prompts and configuration, never shell arguments.
async function main() {
const inputPath = process.argv[2];
const input = JSON.parse(await readFile(inputPath, 'utf8'));
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
let diagnosticProxy;
let improvementBridge;
let approvalBridge;
let retry;
const emitRetry = value => publish({ type: 'runtime.retry', retry: value });
const onDiagnostic = diagnostic => {
  void publish({ type: 'runtime.diagnostic', diagnostic }).catch(() => {});
  if (diagnostic.event === 'api.retry' || diagnostic.event === 'api.retrying') {
    retry = { attempt: diagnostic.attempt, maxRetries: diagnostic.maxRetries,
      delayMs: diagnostic.delayMs ?? retry?.delayMs ?? 0,
      nextRetryAt: diagnostic.nextRetryAt ?? retry?.nextRetryAt ?? new Date().toISOString(),
      status: diagnostic.event === 'api.retry' ? 'waiting' : 'retrying' };
    void emitRetry(retry).catch(() => {});
  } else if (diagnostic.event === 'api.end' && retry) { retry = undefined; void emitRetry(null).catch(() => {}); }
};
try {
  await publish({ type: 'runtime.worker_started' });
  if (input.baseUrl) {
    diagnosticProxy = await startDiagnosticProxy({
      upstreamBaseUrl: input.baseUrl,
      secrets: [process.env.CODEX_API_KEY].filter(Boolean),
      onEvent: onDiagnostic,
      overloadRetries: createOverloadRetryOptions(input, onDiagnostic),
    });
  }
  const proxy = input.baseUrl ? {
    model_provider: 'codex_web_proxy',
    model_providers: { codex_web_proxy: {
      name: 'Codex Web proxy', base_url: diagnosticProxy.baseUrl, wire_api: 'responses',
      supports_websockets: false, env_key: 'CODEX_API_KEY',
      request_max_retries: 0, stream_max_retries: 0,
    } },
  } : {};
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
  const codex = new Codex({
    apiKey: process.env.CODEX_API_KEY,
    config: { ...extra, ...proxy, model_providers: { ...extra.model_providers, ...proxy.model_providers },
      ...((improvementBridge || approvalBridge) ? {
        mcp_servers: { ...extra.mcp_servers,
          ...(improvementBridge ? { swarm_improvements: improvementBridge.config } : {}),
          ...(approvalBridge ? { swarm_approvals: approvalBridge.config } : {}),
        },
      } : {}),
    },
    configOverrides: [...(input.configOverrides ?? []), ...(input.baseUrl ? [
      'model_providers.codex_web_proxy.request_max_retries=0',
      'model_providers.codex_web_proxy.stream_max_retries=0',
    ] : [])],
  });
  const { settings } = input;
  const options = {
    workingDirectory: settings.workingDirectory,
    ...(settings.model ? { model: settings.model } : {}),
    modelReasoningEffort: settings.modelReasoningEffort,
    // The explicit SDK --sandbox option overrides persisted thread settings;
    // E2B itself is the isolation boundary, including for user-level caches.
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
  for await (const event of events) await publish(event);
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
  try { await Promise.all([diagnosticProxy?.close(), improvementBridge?.close(), approvalBridge?.close()]); }
  finally {
    if (retry) { retry = undefined; await emitRetry(null).catch(() => {}); }
    await publishing;
    await writeState().catch(() => {});
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
