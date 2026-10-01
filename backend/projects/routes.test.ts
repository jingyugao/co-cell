import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { WorkspaceFile } from '../../protocol/workspace-types.js';
import type { WorkspaceFileResult } from '../workspaces/files.js';
import { installProjectsRoutes } from './routes.js';

function fixture(contents: Buffer, image = false) {
  let calls = 0;
  const file: WorkspaceFile = {
    path: `/home/agent/workspace/${image ? 'pixel.png' : 'export.tsv'}`,
    name: image ? 'pixel.png' : 'export.tsv',
    size: contents.length,
    kind: image ? 'image' : 'binary',
    mimeType: image ? 'image/png' : 'application/octet-stream',
  };
  const projectFile = async (projectId: string, path: string): Promise<WorkspaceFileResult> => {
    assert.equal(projectId, 'test-project');
    assert.equal(path, file.path);
    calls++;
    return { file, data: contents };
  };
  const app = new Hono();
  installProjectsRoutes(app, { projectFile } as Parameters<typeof installProjectsRoutes>[1]);
  const url = `/api/projects/test-project/files?path=${encodeURIComponent(file.path)}`;
  return { app, url, file, calls: () => calls };
}

function exportContents() {
  const contents = Buffer.alloc(2 * 1024 * 1024 + 37, 'x');
  contents.write('id\tvalue\n1\tfirst\n');
  contents.write('\nlast\tcomplete\n', contents.length - 15);
  return contents;
}

test('download returns the already-read complete attachment with one project file read', async () => {
  const contents = exportContents();
  const { app, url, calls } = fixture(contents);
  const response = await app.request(`${url}&download=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(contents.length));
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(contents), 'raw attachment must include every byte');
  assert.equal(calls(), 1);
});

test('HEAD downloads read once, preserve size and return no body', async () => {
  const contents = exportContents();
  const { app, url, calls } = fixture(contents);
  const response = await app.request(`${url}&download=1`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(contents.length));
  assert.equal(response.body, null);
  assert.equal(calls(), 1);
});

test('ordinary preview returns JSON metadata from a single full file read', async () => {
  const { app, url, file, calls } = fixture(exportContents());
  const response = await app.request(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^application\/json/);
  assert.deepEqual(await response.json(), file);
  assert.equal(calls(), 1);
});

test('raw binary previews reuse one read for the attachment response', async () => {
  const contents = Buffer.from('binary data');
  const { app, url, calls } = fixture(contents);
  const response = await app.request(`${url}&raw=1`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), contents);
  assert.equal(calls(), 1);
});

test('raw PNG previews preserve inline image content and MIME type', async () => {
  const contents = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=', 'base64');
  const { app, url, calls } = fixture(contents, true);
  const response = await app.request(`${url}&raw=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(contents.length));
  assert.match(response.headers.get('content-disposition')!, /^inline;/);
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(contents));
  assert.equal(calls(), 1);
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
