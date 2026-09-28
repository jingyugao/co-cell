import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { appendFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SandboxHandle } from '@co-cell/sandbox';
import { HttpError } from '../../util/errors.js';
import { MAX_FILE_BYTES } from '../workspaces/files.js';
import { readCellboxWorkspaceFile } from './cellbox-files.js';

function localCellbox(onChunk?: (count: number) => void) {
  const requests: Array<{ metadataOnly?: boolean; offset?: number; length?: number; version?: string }> = [];
  let maxStdout = 0;
  let chunks = 0;
  const sandbox = {
    sandboxId: 'local-test', getHost: () => '127.0.0.1', setTimeout: async () => {},
    commands: { run: async (command: string, options: { user?: string; envs?: Record<string, string> }) => {
      assert.equal(options.user, 'agent');
      assert(Buffer.byteLength(command) <= 8192);
      const request = JSON.parse(options.envs!.COCELL_FILE_REQUEST) as { metadataOnly?: boolean; offset?: number; length?: number; version?: string };
      requests.push(request);
      if (!request.metadataOnly) onChunk?.(++chunks);
      const child = spawnSync('/bin/sh', ['-c', command], {
        env: { ...process.env, ...options.envs }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw Object.assign(new Error(child.stderr), { exitCode: child.status });
      maxStdout = Math.max(maxStdout, Buffer.byteLength(child.stdout));
      if (Buffer.byteLength(child.stdout) > 1024 * 1024) throw new Error('Cellbox guest stdout limit exceeded');
      return { stdout: child.stdout, stderr: child.stderr, exitCode: 0 };
    } },
  } as unknown as SandboxHandle;
  return { sandbox, requests, maxStdout: () => maxStdout };
}

test('reads a multi-megabyte file in 512 KiB chunks below the guest stdout cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cellbox-files-'));
  try {
    const path = join(directory, "large'file.bin");
    const source = Buffer.alloc(2 * 1024 * 1024 + 17, 0x61);
    await writeFile(path, source);
    const fixture = localCellbox();
    const output = await readCellboxWorkspaceFile(fixture.sandbox, process.execPath, directory, path);
    assert.deepEqual(output.data, source);
    assert.equal(output.file.size, source.length);
    assert.equal(output.file.kind, 'binary');
    assert.equal(fixture.requests.filter(value => value.metadataOnly).length, 1);
    assert.equal(fixture.requests.filter(value => !value.metadataOnly).length, 5);
    assert(fixture.requests.filter(value => !value.metadataOnly).every(value => value.length! <= 512 * 1024 && value.version === output.version));
    assert(fixture.maxStdout() < 1024 * 1024);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('preserves metadata previews and bounded ranged reads for files above 10 MiB', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cellbox-files-'));
  try {
    const path = join(directory, 'large.bin');
    await writeFile(path, Buffer.alloc(0));
    await truncate(path, MAX_FILE_BYTES + 1);
    const fixture = localCellbox();
    const preview = await readCellboxWorkspaceFile(fixture.sandbox, process.execPath, directory, path);
    assert.equal(preview.file.size, MAX_FILE_BYTES + 1);
    assert.equal(preview.data.length, 0);
    assert.equal(fixture.requests.length, 1);
    const metadata = await readCellboxWorkspaceFile(fixture.sandbox, process.execPath, directory, path, { metadataOnly: true });
    assert.equal(metadata.version, preview.version);
    assert.equal(fixture.requests.length, 2);
    const ranged = await readCellboxWorkspaceFile(fixture.sandbox, process.execPath, directory, path,
      { offset: 1024, length: 600 * 1024, version: preview.version });
    assert.equal(ranged.data.length, 600 * 1024);
    assert(ranged.data.every(byte => byte === 0));
    assert.equal(fixture.requests.filter(value => !value.metadataOnly).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects a version change between chunks and a request above the guest env limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cellbox-files-'));
  try {
    const path = join(directory, 'change.bin');
    await writeFile(path, Buffer.alloc(1024 * 1024, 0x62));
    const fixture = localCellbox(count => { if (count === 2) appendFileSync(path, 'changed'); });
    await assert.rejects(readCellboxWorkspaceFile(fixture.sandbox, process.execPath, directory, path),
      (error: unknown) => error instanceof HttpError && error.status === 409);
    const bounded = localCellbox();
    await assert.rejects(readCellboxWorkspaceFile(bounded.sandbox, process.execPath, directory, path,
      { version: 'x'.repeat(8192) }), (error: unknown) => error instanceof HttpError && error.status === 400);
    assert.equal(bounded.requests.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('accepts a custom shared docs root but rejects a symlink escape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cellbox-files-'));
  const docs = await mkdtemp(join(tmpdir(), 'cellbox-docs-'));
  try {
    const path = join(docs, 'note.txt');
    await writeFile(path, 'hello docs');
    const fixture = localCellbox();
    const output = await readCellboxWorkspaceFile(fixture.sandbox, process.execPath, directory, path, {}, docs);
    assert.equal(output.data.toString(), 'hello docs');
    assert.equal(output.file.kind, 'text');
    const link = join(directory, 'outside.txt');
    symlinkSync(path, link);
    await assert.rejects(readCellboxWorkspaceFile(fixture.sandbox, process.execPath, directory, link, {}, docs),
      (error: unknown) => error instanceof HttpError && error.status === 403);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(docs, { recursive: true, force: true }); }
});
