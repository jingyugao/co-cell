import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import { downloadOssArchive } from './oss-download.js';

test('OSS archive browsing downloads authenticated bytes and rejects corruption', async () => {
  const bytes = Buffer.from('archive contents');
  const server = createServer((request, response) => {
    assert.equal(request.url, '/co-cell-archives/legacy-archives/project/capture.tar.gz');
    assert.match(request.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=test-access\//);
    response.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'cocell-oss-download-'));
  const path = join(directory, 'archive.tar.gz');
  const objectKey = 'legacy-archives/project/capture.tar.gz';
  const ref: RemoteArchiveRef = { id: `oss:${objectKey}`, storageType: 'oss',
    createdAt: new Date().toISOString(), sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), imageId: 'image',
    sourceSandboxId: 'box', threadIds: [], metadata: { bucket: 'co-cell-archives', objectKey, region: 'us-east-1' } };
  try {
    const endpoint = `http://127.0.0.1:${address.port}`;
    await downloadOssArchive(ref, path, endpoint, 'test-access', 'test-secret');
    assert.deepEqual(await readFile(path), bytes);
    await rm(path);
    await assert.rejects(downloadOssArchive({ ...ref, sha256: '0'.repeat(64) }, path,
      endpoint, 'test-access', 'test-secret'), /integrity check failed/);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
