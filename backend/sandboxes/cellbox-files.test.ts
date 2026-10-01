import assert from 'node:assert/strict';
import test from 'node:test';
import { CellboxError, type SandboxHandle } from '@co-cell/sandbox';
import { readCellboxWorkspaceFile, cellboxWorkspaceFileResponse } from './cellbox-files.js';

function fixture() {
  const paths: string[] = [];
  const bytes = Buffer.from([0, 0xff, 0xfe, 0x80]);
  const sandbox = {
    files: { readBytes: async (path: string) => { paths.push(path); return bytes; } },
    commands: { run: async () => { throw new Error('Preview must not execute commands'); } },
  } as unknown as SandboxHandle;
  return { sandbox, paths, bytes };
}

test('preview reads native bytes once and rejects paths outside the project workspace', async () => {
  const { sandbox, paths, bytes } = fixture();
  const output = await readCellboxWorkspaceFile(sandbox, '/workspace', '/workspace/source/main.go');
  assert.deepEqual(output.data, bytes);
  assert.deepEqual(paths, ['/workspace/source/main.go']);
  for (const path of ['/shared/docs/file.md', '/workspace-other/file', '/workspace/../private/file', 'relative.go']) {
    await assert.rejects(readCellboxWorkspaceFile(sandbox, '/workspace', path));
  }
  assert.equal(paths.length, 1, 'invalid paths must not reach the file API');
});

test('native transfer limit and missing file errors are returned as useful HTTP errors', async () => {
  const { sandbox } = fixture();
  for (const [error, status] of [
    [new CellboxError('INVALID_REQUEST', 'File exceeds the 16 MiB REST transfer limit', 400), 413],
    [new CellboxError('NOT_FOUND', 'Guest rejected the requested operation', 404), 404],
  ] as const) {
    sandbox.files.readBytes = async () => { throw error; };
    await assert.rejects(readCellboxWorkspaceFile(sandbox, '/workspace', '/workspace/file'), { status });
  }
});

test('streamed file requests enforce workspace confinement before reaching the native API', async () => {
  const { sandbox, paths } = fixture();
  const request = new Request('http://localhost/files', { headers: { Range: 'bytes=0-4' } });
  sandbox.files.readResponse = async (path, options) => {
    paths.push(path);
    assert.equal(options?.signal, request.signal);
    assert.equal(options?.headers?.get('range'), 'bytes=0-4');
    return new Response('hello', { status: 206 });
  };
  const response = await cellboxWorkspaceFileResponse(sandbox, '/workspace', '/workspace/source/main.go', request);
  assert.equal(response.status, 206); assert.equal(await response.text(), 'hello');
  for (const path of ['/shared/file', '/workspace-other/file', '/workspace/../private/file', 'relative.go']) {
    await assert.rejects(cellboxWorkspaceFileResponse(sandbox, '/workspace', path, request));
  }
  assert.deepEqual(paths, ['/workspace/source/main.go']);
});
