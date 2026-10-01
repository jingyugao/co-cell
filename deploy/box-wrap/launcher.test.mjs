import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parseConfig, startLauncher } from './launcher.mjs';

async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for test condition');
}

test('provisioning waits, starts once on loopback, keeps Codex history, and stops cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-launcher-'));
  const workspace = join(root, 'workspace');
  const startupDirectory = join(root, 'startup');
  await mkdir(workspace);
  const report = join(workspace, 'report.json');
  const fakeCodex = join(workspace, 'fake-codex.mjs');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.APP_TEST_REPORT, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), env: process.env}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const stop = new AbortController();
  const previousEnv = { PATH: process.env.PATH, CELLBOX_TOKEN: process.env.CELLBOX_TOKEN, VIRTUAL_ENV: process.env.VIRTUAL_ENV };
  process.env.PATH = `/opt/project-tools/bin:${process.env.PATH}`;
  process.env.CELLBOX_TOKEN = 'internal-token';
  process.env.VIRTUAL_ENV = '/opt/project-venv';
  try {
    const launched = startLauncher({ workspace, startupDirectory, codex: fakeCodex, pollMs: 20,
      signal: stop.signal, log: () => {} });
    const configPath = join(startupDirectory, 'config.json');
    await until(async () => (await stat(startupDirectory).catch(() => null)) !== null);
    assert.equal(await stat(report).catch(() => null), null);
    await writeFile(configPath, JSON.stringify({ version: 1, appServerArgs: ['-c', 'model="test"', '-c', 'sandbox_mode="workspace-write"'],
      env: { APP_TEST_REPORT: report, OPENAI_API_KEY: 'test-secret' } }), { mode: 0o600 });
    await until(async () => (await stat(report).catch(() => null)) !== null);
    const first = JSON.parse(await readFile(report, 'utf8'));
    assert.deepEqual(first.args, ['app-server', '-c', 'model="test"', '-c', 'sandbox_mode="workspace-write"',
      '-c', 'sandbox_mode="danger-full-access"', '--listen', 'ws://127.0.0.1:4500']);
    assert.equal(first.cwd, workspace);
    assert.equal(first.env.CODEX_HOME, join(workspace, '.cocell', 'codex'));
    assert.equal(first.env.HOME, '/home/agent');
    assert.equal(first.env.OPENAI_API_KEY, 'test-secret');
    assert.equal(first.env.CELLBOX_TOKEN, undefined);
    assert.equal(first.env.PATH, process.env.PATH);
    assert.equal(first.env.VIRTUAL_ENV, '/opt/project-venv');
    assert.equal(await stat(configPath).catch(() => null), null);
    assert.equal((await stat(join(workspace, '.cocell', 'codex'))).mode & 0o777, 0o700);
    await writeFile(configPath, JSON.stringify({ version: 1, appServerArgs: [], env: {} }), { mode: 0o600 });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await readFile(report, 'utf8'), JSON.stringify(first));
    stop.abort();
    assert.equal(await launched, 0);
  } finally {
    stop.abort();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an insecure config file and remote listener overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-launcher-'));
  const workspace = join(root, 'workspace');
  const startupDirectory = join(root, 'startup');
  await mkdir(workspace);
  const stop = new AbortController();
  try {
    const configDir = startupDirectory;
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, appServerArgs: [], env: {} }));
    await chmod(configPath, 0o640);
    await assert.rejects(startLauncher({ workspace, startupDirectory, codex: '/does/not/matter', pollMs: 10,
      signal: stop.signal, log: () => {} }), /mode 0600/);
    assert.throws(() => parseConfig(JSON.stringify({ version: 1,
      appServerArgs: ['--listen', 'ws://0.0.0.0:4500'], env: {} })), /config or feature/);
    assert.throws(() => parseConfig(JSON.stringify({ version: 1,
      appServerArgs: [], env: { CELLBOX_TOKEN: 'private' } })), /invalid provisioning/);
  } finally {
    stop.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test('starts the npm Codex entrypoint when workload PATH cannot find Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-launcher-path-'));
  const workspace = join(root, 'workspace');
  const startupDirectory = join(root, 'startup');
  const report = join(root, 'report.json');
  const fakeCodex = join(root, 'codex.mjs');
  const originalPath = process.env.PATH;
  const stop = new AbortController();
  let launched;
  try {
    await mkdir(workspace);
    await mkdir(startupDirectory);
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ path: process.env.PATH }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    await writeFile(join(startupDirectory, 'config.json'), JSON.stringify({ version: 1, appServerArgs: [], env: {} }), { mode: 0o600 });
    process.env.PATH = '/opt/project-tools/without-node';
    launched = startLauncher({ workspace, startupDirectory, codex: fakeCodex, signal: stop.signal, log: () => {} });
    await until(async () => (await stat(report).catch(() => null)) !== null);
    assert.equal(JSON.parse(await readFile(report, 'utf8')).path, `${dirname(process.execPath)}:/opt/project-tools/without-node`);
    stop.abort();
    assert.equal(await launched, 0);
  } finally {
    stop.abort();
    if (launched) await launched;
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('unexpected Codex exit is reported as launcher failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-launcher-'));
  const workspace = join(root, 'workspace');
  const startupDirectory = join(root, 'startup');
  await mkdir(workspace);
  const fakeCodex = join(workspace, 'fake-codex.mjs');
  try {
    await writeFile(fakeCodex, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    const configDir = startupDirectory;
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ version: 1,
      appServerArgs: [], env: {} }), { mode: 0o600 });
    const logs = [];
    assert.equal(await startLauncher({ workspace, startupDirectory, codex: fakeCodex, pollMs: 10,
      signal: new AbortController().signal, log: message => logs.push(message) }), 1);
    assert.ok(logs.some(message => message.includes('exited (code 0')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
