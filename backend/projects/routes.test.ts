import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { WorkspaceFile } from '../../protocol/workspace-types.js';
import { MAX_FILE_BYTES, type WorkspaceFileReadOptions, type WorkspaceFileResult } from '../workspaces/files.js';
import { installProjectsRoutes } from './routes.js';

function fixture(contents: Buffer, image = false) {
  const calls: Array<WorkspaceFileReadOptions | undefined> = [];
  const file: WorkspaceFile = {
    path: `/home/user/workspace/${image ? 'pixel.png' : 'export.tsv'}`,
    name: image ? 'pixel.png' : 'export.tsv',
    size: contents.length,
    kind: image ? 'image' : 'binary',
    mimeType: image ? 'image/png' : 'application/octet-stream',
  };
  const projectFile = async (projectId: string, path: string, options?: WorkspaceFileReadOptions): Promise<WorkspaceFileResult> => {
    assert.equal(projectId, 'test-project');
    assert.equal(path, file.path);
    calls.push(options);
    const version = 'test-file-version';
    if (options?.metadataOnly || (!options && contents.length > MAX_FILE_BYTES)) {
      return { file, data: Buffer.alloc(0), version };
    }
    if (options?.offset !== undefined) {
      assert.equal(options.version, version);
      assert.ok(options.length! > 0 && options.length! <= 1024 * 1024);
      return { file, data: contents.subarray(options.offset, options.offset + options.length!), version };
    }
    return { file, data: contents, version };
  };
  const app = new Hono();
  installProjectsRoutes(app, { projectFile } as Parameters<typeof installProjectsRoutes>[1]);
  const url = `/api/projects/test-project/files?path=${encodeURIComponent(file.path)}`;
  return { app, url, file, calls };
}

function largeExport() {
  const contents = Buffer.alloc(MAX_FILE_BYTES + 37, 'x');
  contents.write('id\tvalue\n1\tfirst\n');
  contents.write('\nlast\tcomplete\n', contents.length - 15);
  return contents;
}

test('raw large files stream the complete attachment instead of an empty preview buffer', async () => {
  const contents = largeExport();
  const { app, url, calls } = fixture(contents);
  const response = await app.request(`${url}&raw=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(contents.length));
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(contents), 'raw attachment must include every byte');
  assert.ok(calls.some(options => options?.metadataOnly));
  assert.ok(calls.some(options => options?.offset !== undefined));
});

test('raw non-image attachments honor Range and return the requested bytes', async () => {
  const contents = largeExport();
  const { app, url } = fixture(contents);
  const start = MAX_FILE_BYTES - 4;
  const end = MAX_FILE_BYTES + 12;
  const response = await app.request(`${url}&raw=1`, { headers: { Range: `bytes=${start}-${end}` } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${contents.length}`);
  assert.equal(response.headers.get('content-length'), String(end - start + 1));
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(contents.subarray(start, end + 1)));
});

test('ordinary large-file preview still returns JSON metadata without reading chunks', async () => {
  const { app, url, file, calls } = fixture(largeExport());
  const response = await app.request(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^application\/json/);
  assert.deepEqual(await response.json(), file);
  assert.deepEqual(calls, [undefined]);
});

test('raw PNG previews preserve inline image content and MIME type', async () => {
  const contents = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=', 'base64');
  const { app, url, calls } = fixture(contents, true);
  const response = await app.request(`${url}&raw=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(contents.length));
  assert.match(response.headers.get('content-disposition')!, /^inline;/);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(contents));
  assert.deepEqual(calls, [undefined]);
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
