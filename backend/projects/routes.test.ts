import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { installProjectsRoutes } from './routes.js';

function fixture(upstream: (request: Request) => Response, filePath = '/workspace/test.html') {
  let calls = 0;
  const app = new Hono();
  installProjectsRoutes(app, { projectFileResponse: async (id: string, path: string, request: Request) => {
    assert.equal(id, 'test-project'); assert.equal(path, filePath);
    calls++; return upstream(request);
  } } as unknown as Parameters<typeof installProjectsRoutes>[1]);
  return { app, url: `/api/projects/test-project/files/content?path=${encodeURIComponent(filePath)}`, calls: () => calls };
}

test('file content is streamed as safe bytes, including the legacy URL', async () => {
  for (const legacy of [false, true]) {
    const { app, url, calls } = fixture(() => new Response('<script>example</script>', {
      headers: { 'Content-Type': 'text/html', 'Content-Length': '24', 'Last-Modified': 'Thu, 01 Oct 2026 00:00:00 GMT' },
    }));
    const response = await app.request(legacy ? url.replace('/content', '') : url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(response.headers.get('content-disposition')!, /^inline;/);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(await response.text(), '<script>example</script>');
    assert.equal(calls(), 1);
  }
});

test('HEAD forwards the method and returns full length without a body', async () => {
  const { app, url } = fixture(request => {
    assert.equal(request.method, 'HEAD');
    return new Response(null, { headers: { 'Content-Length': '20000000', 'Accept-Ranges': 'bytes' } });
  });
  const response = await app.request(url, { method: 'HEAD' });
  assert.equal(response.headers.get('content-length'), '20000000');
  assert.equal(response.body, null);
});

test('Range and conditional responses preserve upstream status and headers', async () => {
  for (const status of [206, 304, 416]) {
    const { app, url } = fixture(request => {
      assert.equal(request.headers.get('range'), 'bytes=0-4');
      assert.equal(request.headers.get('if-range'), '"version"');
      return new Response(status === 304 ? null : status === 206 ? 'hello' : '', { status,
        headers: { 'Content-Range': status === 416 ? 'bytes */13' : 'bytes 0-4/13', 'Accept-Ranges': 'bytes', ETag: '"version"' } });
    });
    const response = await app.request(url, { headers: { Range: 'bytes=0-4', 'If-Range': '"version"' } });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('etag'), '"version"');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-range'), status === 416 ? 'bytes */13' : 'bytes 0-4/13');
    if (status === 304) assert.equal(response.headers.get('content-disposition'), null);
    if (status === 206) assert.equal(await response.text(), 'hello');
  }
});

test('downloads preserve the entire stream above the old 16 MiB limit', async () => {
  const contents = Buffer.alloc(17 * 1024 * 1024, 'x');
  const { app, url } = fixture(() => new Response(contents, { headers: { 'Content-Length': String(contents.length) } }));
  const response = await app.request(url + '&download=1');
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(contents));
});

test('native PDF and media viewing is inline, preserves ranges, and allows forced download', async () => {
  for (const mime of ['application/pdf', 'audio/mpeg', 'video/mp4']) {
    for (const download of [false, true]) {
      const { app, url } = fixture(() => new Response('hello', { status: 206, headers: {
        'Content-Type': mime, 'Content-Range': 'bytes 0-4/100', 'Content-Length': '5', 'Accept-Ranges': 'bytes',
      } }), '/workspace/view.pdf');
      const response = await app.request(url + (download ? '&download=1' : ''), { headers: { Range: 'bytes=0-4' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-type'), mime);
      assert.match(response.headers.get('content-disposition')!, download ? /^attachment;/ : /^inline;/);
      assert.equal(response.headers.get('content-range'), 'bytes 0-4/100');
      assert.equal(response.headers.get('content-length'), '5');
      assert.ok(!response.headers.get('content-security-policy')!.includes('sandbox'));
      assert.match(response.headers.get('content-security-policy')!, /media-src 'self' blob:/);
      assert.equal(await response.text(), 'hello');
    }
  }
});

test('rebuild endpoint returns the newly bound Sandbox for an archived project', async () => {
  const calls: string[] = [];
  const app = new Hono();
  installProjectsRoutes(app, {
    rebuildProjectSandbox: async (projectId: string) => {
      calls.push(projectId);
      return { id: projectId, sandbox: { id: 'new-sandbox', status: 'ready' } } as never;
    },
  } as unknown as Parameters<typeof installProjectsRoutes>[1]);

  const response = await app.request('/api/projects/project-to-rebuild/sandbox/rebuild', { method: 'POST' });
  assert.equal(response.status, 202);
  assert.deepEqual(calls, ['project-to-rebuild']);
  assert.deepEqual(await response.json(), {
    id: 'project-to-rebuild',
    sandbox: { id: 'new-sandbox', status: 'ready' },
  });

  for (const removed of ['archive', 'restore', 'reclaim']) {
    assert.equal((await app.request(`/api/projects/project-to-rebuild/sandbox/${removed}`, { method: 'POST' })).status, 404);
  }
});

test('resume endpoint returns the resumed project', async () => {
  const app = new Hono();
  installProjectsRoutes(app, {
    resumeProjectSandbox: async (id: string) => ({ id, sandbox: { id: 'same-sandbox', status: 'ready' } }) as never,
  } as unknown as Parameters<typeof installProjectsRoutes>[1]);
  const response = await app.request('/api/projects/project-to-resume/sandbox/resume', { method: 'POST' });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: 'project-to-resume', sandbox: { id: 'same-sandbox', status: 'ready' } });
});

test('project reads forward an exact bounded operation wait and reject unbounded waits', async () => {
  const app = new Hono();
  const calls: unknown[] = [];
  app.onError((_error, c) => c.json({ error: 'invalid request' }, 400));
  const manager: Pick<Parameters<typeof installProjectsRoutes>[1], 'readProject'> = { async readProject(id, options, signal) {
    calls.push({ id, options }); assert(signal instanceof AbortSignal); return { id } as never;
  } };
  installProjectsRoutes(app, manager as unknown as Parameters<typeof installProjectsRoutes>[1]);
  const response = await app.request('/api/projects/project-1?waitForOperation=operation-1&waitMs=10000');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, [{ id: 'project-1', options: { waitForOperation: 'operation-1', waitMs: 10_000 } }]);
  for (const query of ['waitMs=10', 'waitForOperation=', 'waitForOperation=operation-1&waitMs=10001',
    'waitForOperation=operation-1&waitMs=-1', 'waitForOperation=operation-1&waitMs=1.5']) {
    assert.equal((await app.request(`/api/projects/project-1?${query}`)).status, 400);
  }
  assert.equal(calls.length, 1);
});
