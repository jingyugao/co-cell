import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceDownload } from './download.js';
import type { WorkspaceFileResult } from './files.js';

const result = (data: Buffer): WorkspaceFileResult => ({
  file: { path: '/workspace/export.tsv', name: 'export.tsv', size: data.length,
    kind: 'binary', mimeType: 'application/octet-stream' },
  data,
});

test('downloads the already-read bytes with safe attachment headers', async () => {
  const data = Buffer.from('id\tvalue\n1\tfirst\n');
  const response = workspaceDownload(result(data));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-length'), String(data.length));
  assert.match(response.headers.get('content-disposition')!, /^attachment;.*filename\*=UTF-8''export.tsv$/);
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
});

test('HEAD preserves attachment headers and omits the body', () => {
  const response = workspaceDownload(result(Buffer.from('contents')), true);
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('content-length'), '8');
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
});
