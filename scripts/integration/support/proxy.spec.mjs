import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { LiveEnvironment, liveConfig } from './environment.mjs';
import { startBrowserProxy } from './proxy.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('browser proxy streams an owned resume SSE request without buffering or replay', async () => {
  const firstEvent = deferred();
  const finishStream = deferred();
  let submissions = 0;
  let upstreamHeaders;
  const upstream = createServer(async (request, response) => {
    submissions++;
    upstreamHeaders = request.headers;
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    response.write('event: progress\ndata: {"stage":"received","sequence":1}\n\n');
    firstEvent.resolve();
    await finishStream.promise;
    response.end('event: complete\ndata: {"id":"project-owned"}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const environment = new LiveEnvironment(liveConfig({
    COCELL_E2E_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    COCELL_E2E_PUBLIC_URL: 'http://cellbox.test',
    COCELL_E2E_ACCESS_TOKEN: 'proxy-test-token',
  }));
  environment.projects.set('project-owned', environment.name('owned'));
  const proxy = await startBrowserProxy(environment);
  try {
    await assert.rejects(environment.fetch('/healthz', { accept: 'application/json' }), /Only the event-stream Accept header/);
    const responsePromise = fetch(`${proxy.url}/api/projects/project-owned/sandbox/resume`, {
      method: 'POST', headers: { Accept: 'text/event-stream' },
    });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream; charset=utf-8$/i);
    assert.equal(upstreamHeaders.accept, 'text/event-stream');
    assert.equal(upstreamHeaders.authorization, 'Bearer proxy-test-token');
    assert.equal(upstreamHeaders.host, 'cellbox.test');
    assert.equal(upstreamHeaders.origin, 'http://cellbox.test');

    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const firstText = new TextDecoder().decode(first.value);
    assert.match(firstText, /event: progress/);
    assert.match(firstText, /"stage":"received"/);
    assert.equal(submissions, 1);

    // An unowned mutation must still be rejected by LiveEnvironment.fetch.
    const rejected = await fetch(`${proxy.url}/api/projects/not-owned/sandbox/resume`, {
      method: 'POST', headers: { Accept: 'text/event-stream' },
    });
    await rejected.arrayBuffer();
    assert.equal(submissions, 1);

    finishStream.resolve();
    let remainder = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += new TextDecoder().decode(chunk.value);
    }
    assert.match(remainder, /event: complete/);
    assert.equal(submissions, 1, 'The resume POST must be forwarded exactly once');
    expect(environment.report.requests).toEqual([{
      method: 'POST', path: '/api/projects/project-owned/sandbox/resume', status: 200,
      durationMs: expect.any(Number),
    }]);
  } finally {
    finishStream.resolve();
    await proxy.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  }
});
