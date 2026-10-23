import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chown, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { restoreCredentialOwnership, runProtectedTool, ToolAuthorizationError } from '../../deploy/box-wrap/protected-tool.mjs';

const execution = overrides => ({ executable: 'fixture-tool', args: ['--configured'], env: {}, timeoutMs: 2000, ...overrides });
const config = { mode: 'home', boxId: 'box-one', url: 'http://broker.example.test' };

test('generic dynamic tools authorize every invocation and preserve arguments, output, exit status and credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-generic-tool-'));
  const home = join(root, 'home'), binaryRoot = join(root, 'bin');
  await mkdir(join(home, '.ssh'), { recursive: true }); await mkdir(binaryRoot);
  await writeFile(join(home, '.ssh/key'), 'private credential');
  await writeFile(join(binaryRoot, 'fixture-tool'), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('rotate'))fs.writeFileSync(process.env.TOOL_CREDENTIAL,'rotated credential');
process.stdout.write(JSON.stringify({args,home:process.env.HOME,credential:fs.readFileSync(process.env.TOOL_CREDENTIAL,'utf8')}));
if(args.includes('fail')){process.stderr.write('native failure\\n');process.exit(7);}
`, { mode: 0o755 });
  const requests = []; let stdout = '', stderr = '';
  const options = { config, homeRoot: home, binaryRoot, stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
    fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, '/api/tool-runtime/authorize');
      assert.equal(new Headers(init.headers).has('authorization'), false);
      const body = JSON.parse(init.body); requests.push(body);
      assert.deepEqual(Object.keys(body).sort(), ['args', 'boxId', 'tool']);
      assert.ok(!JSON.stringify(body).includes('private credential'), 'credential bytes must not cross the authorization boundary');
      return Response.json({ tool: body.tool, args: body.args, home: '/home/debug', path: '.ssh/key',
        execution: execution({ env: { TOOL_CREDENTIAL: '${CREDENTIAL}', TOOL_HOME: '${HOME}' } }), credentialPaths: ['.ssh'] });
    } };
  try {
    assert.equal(await runProtectedTool('ssh', ['rotate', '--host=staging'], options), 0);
    assert.deepEqual(JSON.parse(stdout), { args: ['--configured', 'rotate', '--host=staging'], home, credential: 'rotated credential' });
    assert.equal(stderr, '');
    stdout = '';
    assert.equal(await runProtectedTool('ssh', ['fail'], { ...options, config: { ...config, boxId: 'box-two' } }), 7);
    assert.equal(stderr, 'native failure\n');
    assert.equal(requests.length, 2, 'each dynamic invocation must be authorized');
    assert.deepEqual(requests.map(request => request.boxId), ['box-one', 'box-two']);
    assert.deepEqual(requests.map(request => request.tool), ['ssh', 'ssh']);
    assert.deepEqual(await readFile(join(home, '.ssh/key'), 'utf8'), 'rotated credential');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dynamic execution metadata and credential paths are validated before spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-tool-boundary-'));
  const binaryRoot = join(root, 'bin'); await mkdir(binaryRoot);
  const base = { config, binaryRoot, stdout: { write() {} }, stderr: { write() {} } };
  const reply = value => async () => Response.json(value);
  const authorize = fetch => runProtectedTool('mysql', ['--login-path=reports'], { ...base, fetch });
  try {
    const valid = { tool: 'mysql', args: ['--login-path=reports'], home: '/home/debug', path: '.config/login', execution: execution() };
    await assert.rejects(authorize(reply({ ...valid, execution: undefined })), /Dynamic tool is no longer configured/);
    await assert.rejects(authorize(reply({ ...valid, home: '/home/debug/alternate' })), /Invalid tool authorization/);
    await assert.rejects(authorize(reply({ ...valid, path: '../escape' })), /Invalid tool authorization/);
    await assert.rejects(authorize(reply({ ...valid, execution: execution({ executable: '/tmp/attacker' }) })), /Invalid dynamic tool execution/);
    await assert.rejects(authorize(reply({ ...valid, execution: execution({ env: { HOME: '/attacker' } }) })), /Invalid dynamic tool environment/);
    await assert.rejects(authorize(reply({ ...valid, execution: execution({ env: { TOKEN: '${CREDENTIAL}' } }), path: undefined })), /requires a configured credential/);
    await assert.rejects(authorize(reply({ ...valid, args: ['\0'] })), /Invalid tool authorization/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('authorization errors show bounded sanitized 4xx details and hide malformed or server-error bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-auth-error-'));
  const base = { config, stdout: { write() {} }, stderr: { write() {} } };
  const authorize = fetch => runProtectedTool('mysql', ['--version'], { ...base, fetch });
  try {
    const controls = `line\nsecret\u0000token`, longDetail = 'x'.repeat(1500);
    await assert.rejects(authorize(async () => Response.json({ error: `${controls}${longDetail}` }, { status: 403 })), error => {
      assert.ok(error instanceof ToolAuthorizationError);
      assert.match(error.message, /^Tool authorization failed \(HTTP 403\): line secret tokenx+$/);
      assert.ok(error.message.length <= 'Tool authorization failed (HTTP 403): '.length + 1024);
      return true;
    });
    for (const response of [
      new Response('{not-json', { status: 403, headers: { 'content-type': 'application/json' } }),
      new Response('internal secret body', { status: 500, headers: { 'content-type': 'text/plain' } }),
      Response.json({ error: 'server secret detail' }, { status: 500 }),
    ]) await assert.rejects(authorize(async () => response.clone()), error => {
      assert.ok(error instanceof ToolAuthorizationError);
      assert.match(error.message, /Tool authorization failed \(HTTP (403|500)\)$/);
      assert.doesNotMatch(error.message, /secret|not-json/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('credential ownership repair restores debug-home ownership without changing file bytes', { skip: process.getuid?.() !== 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-credential-owner-'));
  const home = join(root, 'home'), ssh = join(home, '.ssh'), key = join(ssh, 'key');
  try {
    await mkdir(ssh, { recursive: true }); await writeFile(key, 'unchanged private bytes', { mode: 0o600 });
    await chown(home, 65534, 65534);
    await restoreCredentialOwnership(home, ['.ssh']);
    assert.equal((await stat(ssh)).uid, 65534);
    assert.equal((await stat(key)).uid, 65534);
    assert.equal(await readFile(key, 'utf8'), 'unchanged private bytes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsupported runtime modes fail before authorization or dynamic execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-unsupported-runtime-'));
  const marker = join(root, 'executed');
  try {
    await assert.rejects(runProtectedTool('mysql', ['--version'], {
      config: { mode: 'files', files: [{ path: '/must-not-be-read' }] },
      fetch: async () => { assert.fail('authorization must not happen in an unsupported mode'); },
    }), /Unsupported tool runtime mode 'files'/);
    assert.equal(await readFile(marker, 'utf8').catch(() => ''), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('installed CLI launchers and dynamic wrappers resolve the same current catalog tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-launcher-catalog-'));
  try {
    const catalog = join(root, 'catalog.json'), allowed = join(root, 'allowed.json'), agent = join(root, 'agent'), client = join(root, 'client.mjs');
    await writeFile(catalog, JSON.stringify({ tools: [{ name: 'glab' }, { name: 'new-cli' }] }));
    await writeFile(allowed, JSON.stringify(['cocell_tool']));
    await writeFile(agent, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))`, { mode: 0o755 });
    let source = await readFile(new URL('../../deploy/box-wrap/tool-client.mjs', import.meta.url), 'utf8');
    source = source.replace('../../util/tool-working-directory.mjs', pathToFileURL(new URL('../../util/tool-working-directory.mjs', import.meta.url).pathname).href)
      .replaceAll('/var/lib/cellbox/shared/tools/current/catalog.json', catalog)
      .replaceAll('/opt/product/cocell/proxy-tool-ids.json', allowed)
      .replaceAll('/opt/cellbox/bin/cellbox-container-agent', agent);
    await writeFile(client, source);
    const invoke = args => spawnSync(process.execPath, [client, ...args], { cwd: root, encoding: 'utf8' });
    for (const [name, args] of [['glab', ['auth', 'status']], ['new-cli', ['--help']]]) {
      const dynamic = invoke(['--dynamic', name, ...args]);
      const installed = invoke([`cocell_${name.replaceAll('-', '_')}`, ...args]);
      assert.equal(dynamic.status, 0, dynamic.stderr); assert.equal(installed.status, 0, installed.stderr);
      assert.deepEqual(JSON.parse(installed.stdout), JSON.parse(dynamic.stdout));
      assert.deepEqual(JSON.parse(installed.stdout).slice(0, 3), ['tool', 'cocell_tool', name]);
    }
    assert.equal(invoke(['cocell_removed', 'auth', 'status']).status, 2);
    await writeFile(catalog, JSON.stringify({ tools: [{ name: 'new-cli' }, { name: 'new_cli' }] }));
    assert.equal(invoke(['cocell_new_cli', '--help']).status, 2, 'ambiguous catalog names must fail closed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
