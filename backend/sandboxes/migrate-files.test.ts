import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { Sandbox } from 'e2b';
import type { SandboxArchive } from '../../protocol/sandbox-types.js';
import { LocalSandboxArchiveStorage, type SandboxArchiveStorage } from './archive-storage.js';
import {
  archiveSandboxFiles, restoreSandboxFiles, sandboxMigrationScriptTestSupport,
} from './migrate-files.js';

const HASH_A = 'a'.repeat(64);
const run = promisify(execFile);

class MemoryArchiveStorage implements SandboxArchiveStorage {
  bytes?: Buffer;
  deleted = false;

  async put(source: string | NodeJS.ReadableStream): Promise<SandboxArchive> {
    assert.notEqual(typeof source, 'string');
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    this.bytes = Buffer.concat(chunks);
    return {
      key: '12345678-1234-1234-1234-123456789abc.tar.gz',
      sizeBytes: this.bytes.length,
      sha256: createHash('sha256').update(this.bytes).digest('hex'),
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  async get(_archive: SandboxArchive, destination: string) {
    assert.ok(this.bytes);
    await writeFile(destination, this.bytes);
  }

  async delete() { this.deleted = true; }
}

async function fakeProcess(proc: string, pid: number, options: { comm: string; state?: 'S' | 'Z' | 'X'; parent?: number; cmdline?: string[] }) {
  const directory = join(proc, String(pid));
  await mkdir(join(directory, 'fd'), { recursive: true });
  await mkdir(join(directory, 'fdinfo'), { recursive: true });
  await writeFile(join(directory, 'status'), `State:\t${options.state ?? 'S'} (test)\nPPid:\t${options.parent ?? 1}\n`);
  await writeFile(join(directory, 'comm'), `${options.comm}\n`);
  await writeFile(join(directory, 'cmdline'), Buffer.from(`${(options.cmdline ?? [options.comm]).join('\0')}\0`));
}

function fixtures(overrides: { prepared?: string; installed?: string; after?: string; writeError?: Error } = {}) {
  const bytes = Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3]);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const sourceRuns: string[] = [];
  const targetRuns: string[] = [];
  let sourceCalls = 0;
  let uploaded: unknown;
  const source = {
    sandboxId: 'source',
    commands: { run: async (command: string) => {
      sourceRuns.push(command);
      if (command.startsWith('rm -f')) return { stdout: '', stderr: '', exitCode: 0 };
      sourceCalls++;
      return { stdout: sourceCalls === 1 ? (overrides.prepared ?? `${HASH_A}\n${hash}\n`) : (overrides.after ?? `${hash}\n${HASH_A}\n`), stderr: '', exitCode: 0 };
    } },
    files: { read: async () => stream() },
  } as unknown as Sandbox;
  const target = {
    sandboxId: 'target',
    commands: { run: async (command: string) => {
      targetRuns.push(command);
      return { stdout: command.startsWith('rm -f') ? '' : (overrides.installed ?? `${hash}\n${HASH_A}\n`), stderr: '', exitCode: 0 };
    } },
    files: { write: async (_path: string, data: ReadableStream) => {
      if (overrides.writeError) throw overrides.writeError;
      uploaded = Buffer.from(await new Response(data).arrayBuffer());
    } },
  } as unknown as Sandbox;
  return { source, target, bytes, hash, sourceRuns, targetRuns, uploaded: () => uploaded };
}

test('archives to independent storage and restores without reading the source sandbox', async () => {
  const value = fixtures();
  const storage = new MemoryArchiveStorage();
  const archive = await archiveSandboxFiles(value.source, '/home/user/project',
    ['12345678-1234-1234-1234-123456789abc'], storage, new AbortController().signal);
  const sourceCallsAfterArchive = value.sourceRuns.length;
  assert.equal(archive.format, 'codex-workspace-v1');
  assert.equal(archive.manifestSha256, HASH_A);
  assert.equal(archive.sourceSandboxId, 'source');
  assert.deepEqual(storage.bytes, value.bytes);

  await restoreSandboxFiles(value.target, archive, storage, new AbortController().signal);
  assert.equal(value.sourceRuns.length, sourceCallsAfterArchive);
  assert.deepEqual(value.uploaded(), value.bytes);
  assert.match(value.sourceRuns[0], /archived_sessions/);
  assert.match(value.sourceRuns[0], /\.codex\/AGENTS\.md/);
  assert.match(value.targetRuns[0], /迁移档案包含不安全路径/);
  assert.match(value.targetRuns[0], /rm -rf -- .*project/);
  assert.ok(value.sourceRuns.at(-1)?.startsWith('rm -f'));
  assert.ok(value.targetRuns.at(-1)?.startsWith('rm -f'));
});

test('generated scripts create, validate, extract, and compare a real archive', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'swarm-hive-migrate-test-'));
  const home = join(temporary, 'home/user');
  const savedHome = join(temporary, 'saved/user');
  const thread = '12345678-1234-1234-1234-123456789abc';
    const archive = join(temporary, 'migration.tar.gz');
  const manifest = join(temporary, 'migration.manifest');
  try {
    await mkdir(join(home, 'project/sub'), { recursive: true });
    await mkdir(join(home, 'project/.git/objects'), { recursive: true });
    await mkdir(join(home, '.codex/sessions/2026/01/01'), { recursive: true });
    await mkdir(join(home, '.codex/docs'), { recursive: true });
    await mkdir(join(home, '.codex-web/images'), { recursive: true });
    await writeFile(join(home, 'project/sub/file'), 'workspace');
    await chmod(join(home, 'project/sub/file'), 0o751);
    await link(join(home, 'project/sub/file'), join(home, 'project/sub/hard-link'));
    await symlink('/var/tmp', join(home, 'project/external'));
    await writeFile(join(home, 'project/.git/HEAD'), 'ref: refs/heads/main\n');
    await run('mkfifo', [join(home, 'project/runtime.pipe')]);
    await writeFile(join(home, `.codex/sessions/2026/01/01/rollout-${thread}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: thread } })}\n`);
    await writeFile(join(home, '.codex/state.json'), '{"persistent":true}');
    await writeFile(join(home, '.codex/AGENTS.md'), 'old managed file');
    await writeFile(join(home, '.codex/docs/shared.md'), 'old managed doc');
    await writeFile(join(home, '.codex-web/images/image.bin'), new Uint8Array([0, 1, 2, 255]));

    const roots = ['/home/user/project', '/home/user/.codex', '/home/user/.codex-web/images'];
    const prepare = sandboxMigrationScriptTestSupport.preflightScript('/home/user/project', roots, [thread], archive, manifest, true)
      .replaceAll('/home/user', home);
    const prepared = await run('bash', ['-c', prepare]);
    assert.match(prepared.stdout, /^[a-f\d]{64}\n[a-f\d]{64}\n$/);
    assert.deepEqual((await readFile(archive)).subarray(0, 2), Buffer.from([0x1f, 0x8b]));

    const storage = new LocalSandboxArchiveStorage(join(temporary, 'archive-storage'));
    const stored = await storage.put(archive);
    await rm(archive);
    const restoredArchive = join(temporary, 'restored.tar.gz');
    await storage.get(stored, restoredArchive);

    await mkdir(join(temporary, 'saved'), { recursive: true });
    await rename(home, savedHome);
    await mkdir(join(home, '.codex/docs'), { recursive: true });
    await writeFile(join(home, '.codex/AGENTS.md'), 'new managed file');
    await writeFile(join(home, '.codex/docs/shared.md'), 'new managed doc');
    const install = sandboxMigrationScriptTestSupport.installScript('/home/user/project', roots, restoredArchive)
      .replaceAll('/home/user', home)
      .replaceAll('"home/user', `"${home.slice(1)}`);
    const installed = await run('bash', ['-c', install]);
    assert.equal(installed.stdout.trim().split(/\s+/)[1], prepared.stdout.trim().split(/\s+/)[0]);
    assert.equal(await readFile(join(home, 'project/sub/file'), 'utf8'), 'workspace');
    assert.equal((await stat(join(home, 'project/sub/file'))).mode & 0o777, 0o751);
    assert.equal((await stat(join(home, 'project/sub/file'))).ino, (await stat(join(home, 'project/sub/hard-link'))).ino);
    assert.equal(await readFile(join(home, 'project/.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    assert.equal(await readlink(join(home, 'project/external')), '/var/tmp');
    await assert.rejects(() => stat(join(home, 'project/runtime.pipe')), /ENOENT/);
    assert.equal(await readFile(join(home, '.codex/AGENTS.md'), 'utf8'), 'new managed file');
    assert.equal(await readFile(join(home, '.codex/docs/shared.md'), 'utf8'), 'new managed doc');
    assert.equal(await readFile(join(home, '.codex/state.json'), 'utf8'), '{"persistent":true}');
    assert.deepEqual(await readFile(join(home, '.codex-web/images/image.bin')), Buffer.from([0, 1, 2, 255]));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('preflight permits only the known read-only plugin probe process tree', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'swarm-hive-migrate-proc-test-'));
  const home = join(temporary, 'home/user');
  const proc = join(temporary, 'proc');
  const archive = join(temporary, 'migration.tar');
  const manifest = join(temporary, 'migration.manifest');
  const gitArgs = ['git', '-c', 'safe.bareRepository=explicit', 'ls-remote', 'https://github.com/openai/plugins.git', 'HEAD'];
  try {
    await mkdir(join(home, 'project'), { recursive: true });
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, 'project/file'), 'content');
    await fakeProcess(proc, 210, { comm: 'git', cmdline: gitArgs });
    await fakeProcess(proc, 211, { comm: 'git-remote-http', parent: 210 });
    await fakeProcess(proc, 212, { comm: 'git-remote-htt', parent: 211 });
    await fakeProcess(proc, 220, { comm: 'node', state: 'Z' });

    const roots = ['/home/user/project', '/home/user/.codex', '/home/user/.codex-web/images'];
    const script = () => sandboxMigrationScriptTestSupport.preflightScript('/home/user/project', roots, [], archive, manifest)
      .replaceAll('/home/user', home)
      .replaceAll('/proc', proc);
    await run('bash', ['-c', script()]);

    await fakeProcess(proc, 230, { comm: 'node', cmdline: ['node', 'server.js'] });
    await assert.rejects(run('bash', ['-c', script()]), error => {
      assert.match(String((error as { stderr?: string }).stderr), /沙箱仍有后台用户进程.*230 node/);
      return true;
    });
    await rm(join(proc, '230'), { recursive: true });

    await symlink(join(home, 'project/file'), join(proc, '210/fd/3'));
    await writeFile(join(proc, '210/fdinfo/3'), 'flags:\t0100001\n');
    await assert.rejects(run('bash', ['-c', script()]), error => {
      assert.match(String((error as { stderr?: string }).stderr), /正在写入待迁移目录/);
      return true;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects a changed source and still cleans temporary archives', async () => {
  const value = fixtures({ after: `${HASH_A}\n${'b'.repeat(64)}\n` });
  const storage = new MemoryArchiveStorage();
  await assert.rejects(() => archiveSandboxFiles(value.source, '/home/user/project', [], storage, new AbortController().signal), /changed during archiving/);
  assert.equal(storage.deleted, true);
  assert.ok(value.sourceRuns.at(-1)?.startsWith('rm -f'));
});

test('rejects unsafe paths and thread ids before touching a sandbox', async () => {
  const value = fixtures();
  const storage = new MemoryArchiveStorage();
  await assert.rejects(() => archiveSandboxFiles(value.source, '/home/user/.codex/sessions', [], storage, new AbortController().signal), /separate directory/);
  await assert.rejects(() => archiveSandboxFiles(value.source, '/home/user/project', ['../thread'], storage, new AbortController().signal), /Invalid Codex thread ID/);
  assert.equal(value.sourceRuns.length, 0);
});

test('cleans the target temporary archive when restore streaming fails', async () => {
  const value = fixtures({ writeError: new Error('upload failed') });
  const storage = new MemoryArchiveStorage();
  const archive = await archiveSandboxFiles(value.source, '/home/user/project', [], storage, new AbortController().signal);
  await assert.rejects(() => restoreSandboxFiles(value.target, archive, storage, new AbortController().signal), /upload failed/);
  assert.ok(value.targetRuns.at(-1)?.startsWith('rm -f'));
});
