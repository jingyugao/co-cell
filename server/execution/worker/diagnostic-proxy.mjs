import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function usageFields(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const inputTokens = usage.input_tokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) return {};
  const cachedInputTokens = usage.cached_input_tokens;
  const outputTokens = usage.output_tokens;
  return {
    inputTokens,
    ...(Number.isSafeInteger(cachedInputTokens) && cachedInputTokens >= 0 ? { cachedInputTokens } : {}),
    ...(Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
  };
}
function forwardedHeaders(headers) {
  const excluded = new Set([...HOP, ...String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase())));
}

export const OVERLOAD_RETRY_DELAYS_MS = Object.freeze([10000, 30000, 60000, 180000]);

/** Loopback observer. Optional retries buffer bounded request/response bytes in memory only. */
export async function startDiagnosticProxy({ upstreamBaseUrl, onEvent, secrets = [], overloadRetries = false }) {
  const upstream = new URL(upstreamBaseUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Invalid diagnostic upstream URL');
  upstream.pathname = `${upstream.pathname.replace(/\/+$/, '')}/responses`;
  const active = new Set();
  let closing = false;
  const redact = value => {
    let text = typeof value === 'string' ? value : '';
    for (const secret of secrets) if (typeof secret === 'string' && secret.length) text = text.split(secret).join('[REDACTED]');
    return text
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, '[REDACTED]')
      .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|password|authorization|secret)\b["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi, '[REDACTED]')
      .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 400);
  };
  const errorFields = value => {
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(['type', 'code', 'message'].flatMap(key => typeof value[key] === 'string' ? [[key, redact(value[key])]] : []));
  };
  const emit = value => {
    try { Promise.resolve(onEvent(value)).catch(() => {}); } catch { /* Diagnostics must never break transport. */ }
  };
  const handleRetriableRequest = (request, response) => {
    const options = typeof overloadRetries === 'object' ? overloadRetries : {};
    const maxRequestBytes = options.maxRequestBytes ?? 8 * 1024 * 1024;
    const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    const requestId = randomUUID(), started = performance.now(), controller = new AbortController();
    let requestBytes = 0, responseBytes = 0, outgoing, incoming, done = false, body, bodyChunks = [];
    let retryAllowed = true, streamRequest = false, streamCommitted = false, heartbeat, retries = 0, status, responseId;
    let headers = { ...forwardedHeaders(request.headers), host: upstream.host, 'accept-encoding': 'identity' };
    let retryHeadersResolved = false;
    const event = (name, extra = {}) => emit({ requestId, event: name, method: 'POST', path: upstream.pathname,
      durationMs: Math.round(performance.now() - started), requestBytes, responseBytes,
      ...(status === undefined ? {} : { status }), ...(responseId ? { responseId } : {}), ...extra });
    const finish = (reason, extra = {}) => {
      if (done) return;
      done = true; clearInterval(heartbeat); active.delete(abort); body = undefined; bodyChunks = [];
      event('api.end', { reason, ...extra });
    };
    const abort = () => {
      if (done) return;
      controller.abort();
      event('api.error', { error: { type: 'cancelled', code: closing ? 'proxy_closed' : 'client_cancelled' } });
      finish('cancelled', { transportComplete: false, clientAborted: !closing });
      outgoing?.destroy(); incoming?.destroy(); request.destroy(); response.destroy();
    };
    active.add(abort);
    request.on('aborted', abort); request.on('error', abort);
    response.on('close', () => { if (!response.writableFinished) abort(); });
    const keepAlive = () => {
      if (!streamRequest || done) return;
      if (!response.headersSent) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.flushHeaders(); streamCommitted = true;
      }
      if (!heartbeat) {
        const ping = () => { if (!done && !response.writableEnded && response.writableLength < 65536) response.write(': waiting for upstream\n\n'); };
        ping(); heartbeat = setInterval(ping, options.keepAliveMs ?? 10000); heartbeat.unref();
      }
    };
    const commitHeaders = upstreamHeaders => {
      if (response.headersSent) return;
      response.writeHead(status, forwardedHeaders(upstreamHeaders)); response.flushHeaders();
    };
    const writeFinal = (chunks, upstreamHeaders, jsonError) => {
      clearInterval(heartbeat); heartbeat = undefined;
      if (streamCommitted && !String(upstreamHeaders['content-type'] ?? '').includes('text/event-stream')) {
        // SSE keepalive already committed HTTP 200. Preserve the actual final
        // upstream error object in an SSE envelope; diagnostics retain its status.
        if (jsonError) response.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: jsonError })}\n\n`);
        else response.destroy();
      } else {
        commitHeaders(upstreamHeaders);
        for (const chunk of chunks) response.write(chunk);
        response.end();
      }
    };
    const overloadCode = error => {
      const codes = new Set(['server_is_overloaded', 'model_at_capacity', 'model_capacity']);
      if (!error || typeof error !== 'object') return undefined;
      return [error.code, error.type].find(value => codes.has(value));
    };
    const delay = milliseconds => {
      if (options.wait) return options.wait(milliseconds, controller.signal);
      return new Promise((resolve, reject) => {
        const cancelled = () => { clearTimeout(timer); reject(new Error('cancelled')); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', cancelled); resolve(); }, milliseconds);
        controller.signal.addEventListener('abort', cancelled, { once: true });
        if (controller.signal.aborted) cancelled();
      });
    };
    const cancellable = promise => new Promise((resolve, reject) => {
      const cancelled = () => { controller.signal.removeEventListener('abort', cancelled); reject(new Error('cancelled')); };
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve(promise).then(value => { controller.signal.removeEventListener('abort', cancelled); resolve(value); }, error => {
        controller.signal.removeEventListener('abort', cancelled); reject(error);
      });
      if (controller.signal.aborted) cancelled();
    });
    const begin = bufferedBody => {
      if (done) return;
      responseId = undefined;
      const requestAttempt = retries + 1;
      event('api.request', { requestAttempt });
      if (done) return;
      outgoing = (upstream.protocol === 'https:' ? https : http).request(upstream, { method: 'POST', headers });
      const attemptRequest = outgoing;
      let settled = false;
      const transportError = code => {
        if (done || settled) return;
        settled = true;
        event('api.error', { error: { type: 'transport_error', code }, requestAttempt });
        finish('transport_error', { transportComplete: false });
        if (!response.headersSent) response.writeHead(502).end(); else response.destroy();
      };
      attemptRequest.on('error', error => transportError(redact(error.code || 'upstream_error')));
      attemptRequest.on('response', upstreamResponse => {
        if (done || settled) { upstreamResponse.destroy(); return; }
        incoming = upstreamResponse; status = incoming.statusCode ?? 502;
        const upstreamHeaders = incoming.headers;
        const requestIds = {};
        for (const name of ['x-request-id', 'request-id', 'openai-request-id', 'x-oneapi-request-id', 'x-amzn-requestid', 'cf-ray']) {
          const value = upstreamHeaders[name];
          if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)) requestIds[name] = redact(value);
        }
        event('api.response', { requestIds, requestAttempt });
        const isSse = String(upstreamHeaders['content-type'] ?? '').includes('text/event-stream');
        const isJson = String(upstreamHeaders['content-type'] ?? '').includes('json');
        const encoding = String(upstreamHeaders['content-encoding'] ?? 'identity').toLowerCase();
        let chunks = [], bytes = 0, passthrough = !retryAllowed || !['identity', ''].includes(encoding), terminal, malformed = false;
        let line = '', data = '', eventName = '';
        const decoder = new StringDecoder('utf8');
        if (passthrough) {
          retryAllowed = false;
          if (encoding !== 'identity' && encoding !== '') event('api.observation', { reason: 'unsupported_content_encoding' });
          if (streamCommitted && (!isSse || !['identity', ''].includes(encoding))) { transportError('incompatible_response_after_sse_keepalive'); incoming.destroy(); return; }
          commitHeaders(upstreamHeaders); incoming.pipe(response);
        } else if (isSse && status === 200) {
          streamRequest = true; keepAlive();
        }
        const dispatch = () => {
          if (!data.trim() || data.trim() === '[DONE]') { data = ''; eventName = ''; return; }
          try {
            const object = JSON.parse(data), type = object.type ?? eventName;
            const id = object.response?.id ?? object.id;
            if (typeof id === 'string' && /^resp_[A-Za-z0-9_-]{1,160}$/.test(id)) responseId = redact(id);
            if (!terminal && ['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(type)) {
              terminal = { type, error: object.error ?? object.response?.error ?? (type === 'error' ? object : undefined), incompleteReason: object.response?.incomplete_details?.reason, usage: object.response?.usage ?? object.usage,
                frame: `event: ${type}\n${data.split('\n').map(value => `data: ${value}`).join('\n')}\n\n` };
            }
          } catch { malformed = true; }
          data = ''; eventName = '';
        };
        const parse = text => {
          line += text;
          for (let end; (end = line.indexOf('\n')) >= 0;) {
            const current = line.slice(0, end).replace(/\r$/, ''); line = line.slice(end + 1);
            if (!current) dispatch();
            else if (current.startsWith('data:')) data += `${data ? '\n' : ''}${current.slice(5).replace(/^ /, '')}`;
            else if (current.startsWith('event:')) eventName = current.slice(6).trim();
          }
        };
        const conclude = async transportComplete => {
          if (done || settled) return;
          settled = true;
          let jsonError;
          if (!passthrough && isJson) {
            try {
              const object = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              jsonError = object.error;
              if (!terminal && ['completed', 'failed', 'incomplete'].includes(object.status)) terminal = { type: `response.${object.status}`, error: object.error };
            } catch { malformed = true; }
          }
          const error = terminal?.error ?? jsonError;
          const code = overloadCode(error);
          const retryableTerminal = terminal && ['response.failed', 'error'].includes(terminal.type);
          const canRetry = !passthrough && !malformed && retryAllowed && body && code && (isSse ? retryableTerminal : status === 503 && isJson);
          // Even when retries are exhausted, never expose a failed attempt's
          // preceding tool events. Only its actual terminal failure is committed.
          if (!passthrough && isSse && terminal && terminal.type !== 'response.completed') chunks = [Buffer.from(terminal.frame)];
          if (error || (terminal && terminal.type !== 'response.completed')) event('api.error', { error: { ...errorFields(error), ...(terminal ? { type: redact(error?.type || terminal.type) } : {}) },
            ...(typeof terminal?.incompleteReason === 'string' ? { incompleteReason: redact(terminal.incompleteReason) } : {}), requestAttempt });
          if (canRetry && retries < OVERLOAD_RETRY_DELAYS_MS.length) {
            incoming.destroy();
            const delayMs = OVERLOAD_RETRY_DELAYS_MS[retries++];
            event('api.retry', { attempt: retries, maxRetries: OVERLOAD_RETRY_DELAYS_MS.length, delayMs, nextRetryAt: new Date(Date.now() + delayMs).toISOString(), code });
            keepAlive();
            if (done) return;
            let resolvedHeaders;
            try {
              const resolution = !retryHeadersResolved && options.resolveRetryHeaders
                ? Promise.resolve().then(() => options.resolveRetryHeaders({ requestHeaders: { ...headers }, responseHeaders: { ...upstreamHeaders }, signal: controller.signal })).catch(() => null)
                : Promise.resolve(headers);
              [, resolvedHeaders] = await cancellable(Promise.all([delay(delayMs), resolution]));
            } catch { if (!done) abort(); return; }
            if (done) return;
            if (!resolvedHeaders || typeof resolvedHeaders !== 'object') {
              event('api.observation', { reason: 'retry_channel_unresolved' });
              finish(terminal?.type ?? 'http_end', { transportComplete, requestAttempt });
              writeFinal(chunks, upstreamHeaders, jsonError ?? terminal?.error); return;
            }
            headers = { ...forwardedHeaders(resolvedHeaders), host: upstream.host, 'accept-encoding': 'identity' };
            retryHeadersResolved = true;
            chunks = [];
            event('api.retrying', { attempt: retries, maxRetries: OVERLOAD_RETRY_DELAYS_MS.length, code });
            begin(body); return;
          }
          if (terminal?.type === 'response.completed') event('api.completed', { requestAttempt, ...usageFields(terminal.usage) });
          if (!passthrough && isSse && !terminal && !malformed) event('api.error', { error: { type: 'stream_error', code: 'eof_before_terminal' }, requestAttempt });
          const reason = terminal?.type ?? (passthrough || malformed ? 'unobserved' : isSse ? 'eof_before_terminal' : 'http_end');
          // Mark the business result before delivery: Codex may disconnect as
          // soon as it reads the terminal event, which is not cancellation.
          finish(reason, { transportComplete, requestAttempt });
          if (!passthrough) writeFinal(chunks, upstreamHeaders, jsonError ?? terminal?.error);
          if (!transportComplete) incoming.destroy();
        };
        incoming.on('data', chunk => {
          if (done || settled) return;
          responseBytes += chunk.length; bytes += chunk.length;
          if (passthrough) return;
          chunks.push(chunk);
          if (bytes > maxResponseBytes) {
            retryAllowed = false; passthrough = true;
            event('api.observation', { reason: 'retry_response_buffer_limit' });
            if (streamCommitted && !isSse) { transportError('incompatible_response_after_sse_keepalive'); incoming.destroy(); return; }
            commitHeaders(upstreamHeaders); clearInterval(heartbeat); heartbeat = undefined;
            for (const buffered of chunks) response.write(buffered);
            chunks = []; data = ''; line = ''; incoming.pipe(response); return;
          }
          if (isSse) {
            parse(decoder.write(chunk));
            if (terminal) void conclude(false).catch(() => {
              if (done) return;
              event('api.error', { error: { type: 'transport_error', code: 'retry_processing_failed' } });
              finish('transport_error', { transportComplete: false }); incoming.destroy(); response.destroy();
            });
          }
        });
        incoming.on('end', () => {
          if (done || settled) return;
          if (!passthrough && isSse) { parse(decoder.end()); if (line) parse('\n'); dispatch(); }
          void conclude(true).catch(() => {
            if (done) return;
            event('api.error', { error: { type: 'transport_error', code: 'retry_processing_failed' } });
            finish('transport_error', { transportComplete: false }); incoming.destroy(); response.destroy();
          });
        });
        incoming.on('aborted', () => transportError('upstream_disconnected'));
        incoming.on('error', () => transportError('upstream_disconnected'));
      });
      if (bufferedBody) attemptRequest.end(bufferedBody);
      return attemptRequest;
    };
    request.on('data', chunk => {
      requestBytes += chunk.length;
      if (!retryAllowed) return;
      bodyChunks.push(chunk);
      if (requestBytes > maxRequestBytes) {
        retryAllowed = false; event('api.observation', { reason: 'retry_request_buffer_limit' });
        const target = begin();
        if (!target) return;
        for (const buffered of bodyChunks) target.write(buffered);
        bodyChunks = []; request.pipe(target);
      }
    });
    request.on('end', () => {
      if (done || !retryAllowed) return;
      body = Buffer.concat(bodyChunks); bodyChunks = [];
      try { streamRequest = JSON.parse(body.toString('utf8')).stream === true; } catch { /* Non-JSON requests remain transparent. */ }
      begin(body);
    });
  };
  const server = http.createServer((request, response) => {
    if (closing || request.method !== 'POST' || request.url !== '/responses') {
      response.writeHead(closing ? 503 : 404).end(); request.resume(); return;
    }
    if (overloadRetries) { handleRetriableRequest(request, response); return; }
    const requestId = randomUUID();
    const started = performance.now();
    let requestBytes = 0, responseBytes = 0, status, finished = false, upstreamResponse, terminalReason, responseId;
    const event = (name, extra = {}) => emit({ requestId, event: name, method: 'POST', path: upstream.pathname, durationMs: Math.round(performance.now() - started), requestBytes, responseBytes, ...(status === undefined ? {} : { status }), ...(responseId ? { responseId } : {}), ...extra });
    const finish = (reason, extra = {}) => {
      if (finished) return;
      finished = true;
      active.delete(abort);
      event('api.end', { reason, ...extra });
    };
    const abort = () => {
      if (finished) return;
      if (!terminalReason) event('api.error', { error: { type: 'cancelled', code: closing ? 'proxy_closed' : 'client_cancelled' } });
      finish(terminalReason ?? 'cancelled', { transportComplete: false, clientAborted: !closing });
      outgoing.destroy(); upstreamResponse?.destroy(); request.destroy(); response.destroy();
    };
    const outgoing = (upstream.protocol === 'https:' ? https : http).request(upstream, {
      method: 'POST', headers: { ...forwardedHeaders(request.headers), host: upstream.host, 'accept-encoding': 'identity' },
    });
    active.add(abort);
    event('api.request');
    request.on('data', chunk => { requestBytes += chunk.length; });
    request.on('aborted', abort);
    request.on('error', abort);
    response.on('close', () => { if (!response.writableFinished) abort(); });
    outgoing.on('error', error => {
      if (finished) return;
      if (!terminalReason) event('api.error', { error: { type: 'transport_error', code: redact(error.code || 'upstream_error') } });
      finish(terminalReason ?? 'transport_error', { transportComplete: false });
      if (!response.headersSent) response.writeHead(502).end(); else response.destroy();
    });
    outgoing.on('response', incoming => {
      upstreamResponse = incoming;
      status = incoming.statusCode ?? 502;
      const requestIds = {};
      for (const name of ['x-request-id', 'request-id', 'openai-request-id', 'x-oneapi-request-id', 'x-amzn-requestid', 'cf-ray']) {
        const value = incoming.headers[name];
        if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)) requestIds[name] = redact(value);
      }
      event('api.response', { requestIds });
      response.writeHead(status, forwardedHeaders(incoming.headers));
      response.flushHeaders();
      const encoding = String(incoming.headers['content-encoding'] ?? 'identity').toLowerCase();
      const contentType = String(incoming.headers['content-type'] ?? '').toLowerCase();
      const isSse = contentType.includes('text/event-stream');
      const isJson = contentType.includes('json');
      let observable = encoding === 'identity' || encoding === '';
      let terminal = false, line = '', eventName = '', data = '', skipping = false, json = '';
      const decoder = new StringDecoder('utf8');
      const limit = 256 * 1024;
      const unobservable = reason => { if (observable) { observable = false; event('api.observation', { reason }); } };
      if (!observable) event('api.observation', { reason: 'unsupported_content_encoding' });
      const observeObject = (object, name) => {
        if (!object || typeof object !== 'object') return;
        const type = typeof object.type === 'string' ? object.type : name;
        const id = object.response?.id ?? object.id;
        if (typeof id === 'string' && /^resp_[A-Za-z0-9_-]{1,160}$/.test(id)) responseId = redact(id);
        if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(type)) {
          terminal = true;
          terminalReason = type;
          if (type === 'response.completed') event('api.completed', usageFields(object.response?.usage ?? object.usage));
          else {
            const error = object.error ?? object.response?.error ?? (type === 'error' ? object : undefined);
            const details = object.response?.incomplete_details;
            event('api.error', { error: { ...errorFields(error), type: redact(error?.type || type) }, ...(typeof details?.reason === 'string' ? { incompleteReason: redact(details.reason) } : {}) });
          }
        }
      };
      const dispatch = () => {
        if (data.trim() && data.trim() !== '[DONE]') {
          try { observeObject(JSON.parse(data), eventName); } catch { unobservable('invalid_sse_json'); }
        }
        data = ''; eventName = '';
      };
      const parseLine = current => {
        if (current.endsWith('\r')) current = current.slice(0, -1);
        if (!current) { dispatch(); return; }
        if (current.startsWith('event:')) eventName = current.slice(6).trim();
        if (current.startsWith('data:')) {
          const value = current.slice(5).replace(/^ /, '');
          if (data.length + value.length > limit) { data = ''; unobservable('sse_event_too_large'); } else data += `${data ? '\n' : ''}${value}`;
        }
      };
      const observe = text => {
        if (!observable) return;
        if (!isSse) {
          if (isJson && json.length + text.length <= limit) json += text;
          else if (isJson) { json = ''; unobservable('json_too_large'); }
          return;
        }
        for (const part of text.split(/(?<=\n)/)) {
          if (!observable) break;
          if (!skipping) line += part;
          if (line.length > limit) { line = ''; skipping = true; unobservable('sse_line_too_large'); }
          if (part.endsWith('\n')) { if (!skipping) parseLine(line.slice(0, -1)); line = ''; skipping = false; }
        }
      };
      incoming.on('data', chunk => { responseBytes += chunk.length; observe(decoder.write(chunk)); });
      incoming.on('end', () => {
        if (finished) return;
        observe(decoder.end());
        if (observable && isSse) {
          if (line) parseLine(line);
          dispatch();
          if (!terminal) event('api.error', { error: { type: 'stream_error', code: 'eof_before_terminal' } });
        } else if (observable && isJson && json) {
          try {
            const object = JSON.parse(json);
            if (object.error) event('api.error', { error: errorFields(object.error) });
            else observeObject(object, object.status === 'completed' ? 'response.completed' : object.status === 'failed' ? 'response.failed' : object.status === 'incomplete' ? 'response.incomplete' : '');
          } catch { event('api.observation', { reason: 'invalid_json' }); }
        }
        finish(terminalReason ?? (!observable ? 'unobserved' : isSse ? 'eof_before_terminal' : 'http_end'), { transportComplete: true });
      });
      const disconnected = () => {
        if (finished) return;
        if (!terminalReason) event('api.error', { error: { type: 'transport_error', code: 'upstream_disconnected' } });
        finish(terminalReason ?? 'transport_error', { transportComplete: false }); response.destroy();
      };
      incoming.on('aborted', disconnected);
      incoming.on('error', disconnected);
      incoming.pipe(response);
    });
    request.pipe(outgoing);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      closing = true;
      for (const abort of [...active]) abort();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    },
  };
}
