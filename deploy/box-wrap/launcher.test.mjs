import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parseConfig, startLauncher } from './launcher.mjs';

test('external model metadata reaches App Server without replacing built-in models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-model-catalog-'));
  const workspace = join(root, 'workspace'), startupDirectory = join(root, 'startup');
  const report = join(root, 'report.json'), codex = join(root, 'codex.mjs');
  const original = { slug: 'template', base_instructions: 'You are an agent based on GPT-5.', experimental_supported_tools: [] };
  const stop = new AbortController(); let launched;
  try {
    await mkdir(workspace); await mkdir(startupDirectory);
    await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'debug') { console.log(JSON.stringify({ models: [${JSON.stringify(original)}] })); process.exit(0); }
const argument = process.argv.find(arg => arg.startsWith('model_catalog_json='));
const path = JSON.parse(argument.slice(argument.indexOf('=') + 1));
writeFileSync(${JSON.stringify(report)}, JSON.stringify({path, catalog:JSON.parse(readFileSync(path)), metadata:process.env.CODEX_MODEL_METADATA_JSON}));
process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);
`, { mode: 0o755 });
    await writeFile(join(startupDirectory, 'config.json'), JSON.stringify({ version: 1, appServerArgs: [], env: {
      CODEX_MODEL_METADATA_JSON: JSON.stringify({ 'external-model': { template: 'template', experimental_supported_tools: ['send_user_message_async'] } }),
    } }), { mode: 0o600 });
    launched = startLauncher({ workspace, agentHome: join(root, 'agent'), startupDirectory, codex, signal: stop.signal, log: () => {} });
    await until(async () => Boolean(await stat(report).catch(() => null)));
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.deepEqual(result.catalog.models[0], original);
    assert.equal(result.catalog.models[1].slug, 'external-model');
    assert.deepEqual(result.catalog.models[1].experimental_supported_tools, ['send_user_message_async']);
    assert(result.catalog.models[1].base_instructions.includes('using external-model'));
    assert.equal(result.metadata, undefined);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  } finally { stop.abort(); if (launched) await launched; await rm(root, { recursive: true, force: true }); }
});

async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for test condition');
}

test('shared startup is reusable across restored workspaces and sees atomic document updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-mounted-launcher-'));
  const workspace = join(root, 'workspace'), sharedDirectory = join(root, 'shared');
  const home = join(workspace, '.cocell', 'codex');
  const report = join(root, 'report.json'), codex = join(root, 'codex.mjs');
  let stop, launched;
  try {
    await mkdir(join(home, 'docs'), { recursive: true });
    await mkdir(join(root, 'agent'));
    await symlink(join(root, 'old-workspace', '.cocell', 'codex'), join(root, 'agent', '.codex'));
    await writeFile(join(home, 'AGENTS.md'), 'archived instructions');
    await writeFile(join(home, 'docs', 'old.txt'), 'archived copy');
    await mkdir(join(sharedDirectory, 'runtime'), { recursive: true });
    await mkdir(join(sharedDirectory, 'docs'));
    await writeFile(join(sharedDirectory, 'AGENTS.md'), 'current instructions');
    await writeFile(join(sharedDirectory, 'docs', 'live.txt'), 'first');
    await writeFile(codex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(report)}, JSON.stringify({key: process.env.CODEX_API_KEY, home: process.env.CODEX_HOME}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const configPath = join(sharedDirectory, 'runtime', 'config.json');
    for (const key of ['first-key', 'second-key']) {
      await rm(report, { force: true });
      await writeFile(configPath, JSON.stringify({ version: 1, appServerArgs: [], env: { CODEX_API_KEY: key } }), { mode: 0o644 });
      stop = new AbortController();
      launched = startLauncher({ agentHome: join(root, 'agent'), workspace, sharedDirectory, codex, signal: stop.signal, log: () => {} });
      await until(async () => Boolean(await stat(report).catch(() => null)));
      assert.equal(JSON.parse(await readFile(report, 'utf8')).key, key);
      assert.equal(await readlink(join(home, 'docs')), join(sharedDirectory, 'docs'));
      assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), 'current instructions');
      assert.equal(await readFile(join(root, 'agent', '.codex', 'AGENTS.md'), 'utf8'), 'current instructions');
      assert(await stat(configPath)); // read-only shared config is never consumed.
      await writeFile(join(sharedDirectory, 'docs', 'new.tmp'), key);
      await rename(join(sharedDirectory, 'docs', 'new.tmp'), join(sharedDirectory, 'docs', 'live.txt'));
      assert.equal(await readFile(join(home, 'docs', 'live.txt'), 'utf8'), key);
      assert.equal(await readFile(join(root, 'agent', '.codex', 'docs', 'live.txt'), 'utf8'), key);
      assert.equal(await stat(join(home, 'docs', 'old.txt')).catch(() => null), null);
      stop.abort();
      assert.equal(await launched, 0);
    }
  } finally {
    stop?.abort();
    if (launched) await launched;
    await rm(root, { recursive: true, force: true });
  }
});

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
    const launched = startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory, codex: fakeCodex, pollMs: 20,
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
    assert.equal(first.env.HOME, join(root, 'agent'));
    assert.equal(await readlink(join(root, 'agent', '.codex')), first.env.CODEX_HOME);
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
    await assert.rejects(startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory, codex: '/does/not/matter', pollMs: 10,
      signal: stop.signal, log: () => {} }), /mode 0600/);
    const existingHome = join(root, 'agent', '.codex');
    await rm(existingHome);
    await mkdir(existingHome);
    await writeFile(join(existingHome, 'config.toml'), 'existing configuration');
    await assert.rejects(startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory,
      signal: stop.signal, log: () => {} }), /existing configuration/);
    assert.equal(await readFile(join(existingHome, 'config.toml'), 'utf8'), 'existing configuration');
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
    launched = startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory, codex: fakeCodex, signal: stop.signal, log: () => {} });
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
    assert.equal(await startLauncher({ agentHome: join(root, 'agent'), workspace, startupDirectory, codex: fakeCodex, pollMs: 10,
      signal: new AbortController().signal, log: message => logs.push(message) }), 1);
    assert.ok(logs.some(message => message.includes('exited (code 0')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
