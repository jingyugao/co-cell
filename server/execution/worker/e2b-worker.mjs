import { readFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import { startDiagnosticProxy } from './diagnostic-proxy.mjs';
import { startImprovementBridge } from './improvement-bridge.mjs';

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

// The private input file carries prompts and configuration, never shell arguments.
async function main() {
const inputPath = process.argv[2];
const input = JSON.parse(await readFile(inputPath, 'utf8'));
await unlink(inputPath);
const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
let diagnosticProxy;
let improvementBridge;
let retry;
const emitRetry = value => process.stdout.write(JSON.stringify({ type: 'runtime.retry', retry: value }) + '\n');
const onDiagnostic = diagnostic => {
  process.stdout.write(JSON.stringify({ type: 'runtime.diagnostic', diagnostic }) + '\n');
  if (diagnostic.event === 'api.retry' || diagnostic.event === 'api.retrying') {
    retry = { attempt: diagnostic.attempt, maxRetries: diagnostic.maxRetries,
      delayMs: diagnostic.delayMs ?? retry?.delayMs ?? 0,
      nextRetryAt: diagnostic.nextRetryAt ?? retry?.nextRetryAt ?? new Date().toISOString(),
      status: diagnostic.event === 'api.retry' ? 'waiting' : 'retrying' };
    emitRetry(retry);
  } else if (diagnostic.event === 'api.end' && retry) { retry = undefined; emitRetry(null); }
};
try {
  if (input.baseUrl) {
    diagnosticProxy = await startDiagnosticProxy({
      upstreamBaseUrl: input.baseUrl,
      secrets: [process.env.CODEX_API_KEY].filter(Boolean),
      onEvent: onDiagnostic,
      overloadRetries: { resolveRetryHeaders: createSameChannelResolver({ upstreamBaseUrl: input.baseUrl, onDiagnostic }) },
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
      emit: event => process.stdout.write(JSON.stringify(event) + '\n'),
    });
  }
  const codex = new Codex({
    apiKey: process.env.CODEX_API_KEY,
    config: { ...extra, ...proxy, model_providers: { ...extra.model_providers, ...proxy.model_providers },
      ...(improvementBridge ? {
        mcp_servers: { ...extra.mcp_servers, swarm_improvements: improvementBridge.config },
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
  for await (const event of events) process.stdout.write(JSON.stringify(event) + '\n');
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  if (process.env.CODEX_API_KEY) message = message.replaceAll(process.env.CODEX_API_KEY, '[REDACTED]');
  process.stderr.write(message + '\n');
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  try { await Promise.all([diagnosticProxy?.close(), improvementBridge?.close()]); }
  finally {
    if (retry) { retry = undefined; emitRetry(null); }
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
