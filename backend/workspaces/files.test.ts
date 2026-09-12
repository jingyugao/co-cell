import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  MAX_FILE_BYTES,
  READ_SANDBOX_FILE_SCRIPT,
  parseWorkspaceFile,
  workspaceFileRequest,
} from './files.js';

const execute = promisify(execFile);
async function readSandboxFile(request: ReturnType<typeof workspaceFileRequest>) {
  const { stdout } = await execute(process.execPath, [
    '-e', READ_SANDBOX_FILE_SCRIPT,
    Buffer.from(JSON.stringify(request)).toString('base64'),
  ], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

test('large file preview retains metadata and bounded reads return the requested bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-file-download-'));
  try {
    const path = join(directory, 'export.tsv');
    const contents = Buffer.alloc(MAX_FILE_BYTES + 1, 'x');
    contents.write('id\tvalue\n');
    contents.write('\nlast-row\tcomplete\n', contents.length - 19);
    await writeFile(path, contents);

    const previewOutput = await readSandboxFile(workspaceFileRequest(directory, path));
    const raw = JSON.parse(previewOutput);
    assert.equal(raw.path, path);
    assert.equal(raw.size, contents.length);
    assert.equal(raw.data, undefined);
    const preview = parseWorkspaceFile(previewOutput);
    assert.equal(preview.file.size, contents.length);
    assert.equal(preview.file.kind, 'binary');
    assert.equal(preview.file.text, undefined);
    assert.equal(preview.data.length, 0);
    assert.ok(preview.version);

    for (const offset of [0, contents.length - 128]) {
      const chunk = parseWorkspaceFile(await readSandboxFile(workspaceFileRequest(directory, path, {
        offset, length: 128, version: preview.version,
      })));
      assert.equal(chunk.file.size, contents.length, 'chunk metadata retains the full file size');
      assert.equal(chunk.version, preview.version);
      assert.ok(chunk.data.equals(contents.subarray(offset, offset + 128)));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('metadata reads omit contents and a changed file invalidates the next chunk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-file-version-'));
  try {
    const path = join(directory, 'export.tsv');
    await writeFile(path, 'original contents');
    const output = await readSandboxFile(workspaceFileRequest(directory, path, { metadataOnly: true }));
    assert.equal(JSON.parse(output).data, undefined);
    const metadata = parseWorkspaceFile(output);
    assert.equal(metadata.file.size, Buffer.byteLength('original contents'));
    assert.equal(metadata.data.length, 0);
    assert.ok(metadata.version);

    await writeFile(path, 'replacement contents with a different size');
    const changed = await readSandboxFile(workspaceFileRequest(directory, path, {
      offset: 0, length: 8, version: metadata.version,
    }));
    assert.equal(JSON.parse(changed).status, 409);
    assert.throws(() => parseWorkspaceFile(changed), { status: 409 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preview, metadata and chunk reads all reject symlinks outside the workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-file-symlink-'));
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const externalPath = join(directory, 'outside.tsv');
    await writeFile(externalPath, 'private contents');
    const path = join(workspace, 'export.tsv');
    await symlink(externalPath, path);
    for (const options of [{}, { metadataOnly: true }, { offset: 0, length: 8 }]) {
      const output = await readSandboxFile(workspaceFileRequest(workspace, path, options));
      assert.equal(JSON.parse(output).status, 403);
      assert.throws(() => parseWorkspaceFile(output), { status: 403 });
      assert.equal(output.includes('private contents'), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid file metadata is rejected', () => {
  for (const size of [-1, '10485761', null]) {
    assert.throws(() => parseWorkspaceFile(JSON.stringify({ path: '/workspace/export.tsv', size })), { status: 502 });
  }
});
