import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceDownload } from './download.js';
import type { WorkspaceFileReadOptions, WorkspaceFileResult } from './files.js';

function source(contents: Buffer) {
  const calls: WorkspaceFileReadOptions[] = [];
  const version = 'stable-file-version';
  const read = async (options: WorkspaceFileReadOptions): Promise<WorkspaceFileResult> => {
    calls.push(options);
    const file = {
      path: '/workspace/export.tsv', name: 'export.tsv', size: contents.length,
      kind: 'binary' as const, mimeType: 'application/octet-stream',
    };
    if (options.metadataOnly) return { file, data: Buffer.alloc(0), version };
    assert.equal(options.version, version, 'every chunk must pin the initial file version');
    assert.equal(typeof options.offset, 'number');
    assert.equal(typeof options.length, 'number');
    assert.ok(options.length! > 0 && options.length! <= 1024 * 1024, 'reads stay bounded to 1 MiB');
    return { file, data: contents.subarray(options.offset!, options.offset! + options.length!), version };
  };
  return { read, calls, version };
}

const body = async (response: Response) => Buffer.from(await response.arrayBuffer());

test('full downloads stream bounded chunks with size, range and version headers', async () => {
  const contents = Buffer.alloc(2 * 1024 * 1024 + 17);
  for (let i = 0; i < contents.length; i++) contents[i] = i % 251;
  const fixture = source(contents);
  const response = await workspaceDownload(fixture.read);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-length'), String(contents.length));
  assert.equal(response.headers.get('etag'), `"${fixture.version}"`);
  assert.equal(response.headers.get('content-range'), null);
  assert.ok((await body(response)).equals(contents));
  assert.equal(fixture.calls[0].metadataOnly, true);
  const chunks = fixture.calls.filter(call => !call.metadataOnly);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(call => call.offset), [0, 1024 * 1024, 2 * 1024 * 1024]);
});

test('closed, open and suffix ranges return 206 and exact content', async () => {
  const contents = Buffer.from('0123456789');
  for (const [range, expected, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=8-99', '89', 'bytes 8-9/10'],
    ['bytes=-99', '0123456789', 'bytes 0-9/10'],
  ]) {
    const fixture = source(contents);
    const response = await workspaceDownload(fixture.read, range);
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), contentRange, range);
    assert.equal(response.headers.get('content-length'), String(expected.length), range);
    assert.equal(await response.text(), expected, range);
  }
});

test('unsatisfiable ranges return 416 without reading file contents', async () => {
  for (const [contents, range] of [
    [Buffer.from('0123456789'), 'bytes=10-'],
    [Buffer.from('0123456789'), 'bytes=-0'],
    [Buffer.alloc(0), 'bytes=0-'],
  ] as const) {
    const fixture = source(contents);
    const response = await workspaceDownload(fixture.read, range);
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${contents.length}`);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].metadataOnly, true);
  }
});

test('malformed and multiple ranges are ignored, and If-Range requires an exact strong ETag', async () => {
  const contents = Buffer.from('0123456789');
  for (const range of ['nonsense', 'items=1-2', 'bytes=0-1,5-6']) {
    const response = await workspaceDownload(source(contents).read, range);
    assert.equal(response.status, 200, range);
    assert.ok((await body(response)).equals(contents));
  }
  for (const ifRange of ['"stale-version"', 'W/"stable-file-version"']) {
    const response = await workspaceDownload(source(contents).read, 'bytes=2-5', ifRange);
    assert.equal(response.status, 200, ifRange);
    assert.ok((await body(response)).equals(contents));
  }
  const fixture = source(contents);
  const response = await workspaceDownload(fixture.read, 'bytes=2-5', `"${fixture.version}"`);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '2345');
});

test('HEAD and empty downloads read metadata only and have no contents', async () => {
  const fixture = source(Buffer.from('0123456789'));
  const head = await workspaceDownload(fixture.read, undefined, undefined, true);
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].metadataOnly, true);

  const emptyFixture = source(Buffer.alloc(0));
  const empty = await workspaceDownload(emptyFixture.read);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal((await body(empty)).length, 0);
  assert.equal(emptyFixture.calls.length, 1);
});
