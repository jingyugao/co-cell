import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runProtectedTool, ToolAuthorizationError } from '../../deploy/box-wrap/protected-tool.mjs';

test('native HOME authorizes each call, persists CLI changes and never transports credential bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-direct-home-'));
  const projectId = randomUUID(), homeRoot = join(root, 'homes'), home = join(homeRoot, projectId), binaryRoot = join(root, 'bin');
  await mkdir(join(home, '.kube'), { recursive: true }); await mkdir(binaryRoot);
  const file = join(home, '.kube/config'); await writeFile(file, 'credential-original');
  await writeFile(join(binaryRoot, 'kubectl'), `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='refresh')fs.writeFileSync(process.env.KUBECONFIG,'credential-refreshed');
console.log(fs.readFileSync(process.env.KUBECONFIG,'utf8')==='credential-refreshed'?'refreshed':'original');
`, { mode: 0o755 });
  const config = { mode: 'home', boxId: 'box-one', url: 'http://broker.example.test' };
  const requests = []; let output = '';
  const options = { config, homeRoot, binaryRoot, stdout: { write(value) { output += value; } }, fetch: async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/tool-runtime/authorize');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    const body = JSON.parse(init.body); requests.push(body);
    assert.deepEqual(Object.keys(body).sort(), ['args', 'boxId', 'tool']);
    return Response.json({ tool: body.tool, args: body.args, home: `/home/debug/${projectId}`, path: '.kube/config' });
  } };
  try {
    assert.equal(await runProtectedTool('kubectl', ['refresh'], options), 0);
    assert.equal(await runProtectedTool('kubectl', ['read'], options), 0);
    assert.deepEqual(output.trim().split('\n'), ['refreshed', 'refreshed']); assert.equal(requests.length, 2);
    assert.equal(await readFile(file, 'utf8'), 'credential-refreshed');
    output = '';
    await assert.rejects(runProtectedTool('kubectl', ['read'], { ...options, fetch: async () => new Response('', { status: 403 }) }), /authorization failed/);
    assert.equal(output, '');
    await assert.rejects(runProtectedTool('kubectl', ['read'], { ...options, fetch: async () => Response.json({ tool: 'kubectl', args: [], home: `/home/debug/${projectId}`, path: '../escape' }) }), /Invalid tool authorization/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mounted HOME preserves native MySQL login paths and Kubernetes contexts against merged credential files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-native-home-'));
  const projectId = randomUUID(), homeRoot = join(root, 'homes'), home = join(homeRoot, projectId), binaryRoot = join(root, 'bin');
  await mkdir(binaryRoot); await mkdir(join(home, '.kube'), { recursive: true });
  const credentials = {
    mysql: { path: '.mylogin.cnf', content: 'merged mysql login paths: reporting, warehouse' },
    kubectl: { path: '.kube/config', content: 'contexts:\n- name: dev\n- name: prod\n' },
  };
  for (const entry of Object.values(credentials)) await writeFile(join(home, entry.path), entry.content);
  await writeFile(join(binaryRoot, 'mysql'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
console.log(JSON.stringify({credential:fs.readFileSync(process.env.MYSQL_TEST_LOGIN_FILE,'utf8'),credentialPath:process.env.MYSQL_TEST_LOGIN_FILE,args}));
`, { mode: 0o755 });
  await writeFile(join(binaryRoot, 'kubectl'), `#!${process.execPath}
const fs=require('node:fs');
console.log(JSON.stringify({credential:fs.readFileSync(process.env.KUBECONFIG,'utf8'),credentialPath:process.env.KUBECONFIG,args:process.argv.slice(2)}));
`, { mode: 0o755 });
  const config = { mode: 'home', boxId: 'box-one', url: 'http://unused.invalid' }, requests = [], outputs = [];
  const options = { config, homeRoot, binaryRoot, stdout: { write(value) { outputs.push(JSON.parse(value)); } }, fetch: async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/tool-runtime/authorize');
    const body = JSON.parse(init.body); requests.push(body);
    const nativeSelectors = body.args.filter(arg => arg.startsWith('--login-path=') || arg.startsWith('--context='));
    assert.equal(nativeSelectors.length, 1, 'the native selector must reach the broker unchanged');
    const expectedTool = nativeSelectors[0].startsWith('--login-path=') ? 'mysql' : 'kubectl';
    assert.equal(body.tool, expectedTool);
    assert.ok(credentials[body.tool], `unexpected tool ${body.tool}`);
    return Response.json({ tool: body.tool, args: body.args, home: `/home/debug/${projectId}`, path: credentials[body.tool].path });
  } };
  try {
    for (const [tool, selector, args] of [
      ['mysql', '--login-path=reporting', ['--login-path=reporting', '-e', 'SELECT 1']],
      ['mysql', '--login-path=warehouse', ['--login-path=warehouse', '-e', 'SELECT 1']],
      ['kubectl', '--context=dev', ['--context=dev', 'get', 'pods']],
      ['kubectl', '--context=prod', ['--context=prod', 'get', 'pods']],
    ]) {
      assert.equal(await runProtectedTool(tool, args, options), 0);
      const result = outputs.at(-1);
      assert.equal(result.credential, credentials[tool].content, `${tool} must read its merged credential file`);
      assert.equal(result.credentialPath, join(home, credentials[tool].path), `${tool} must use the merged native config path`);
      assert.ok(result.args.includes(selector), 'native selector must reach the native CLI unchanged');
      assert.ok(result.args.every(arg => !arg.startsWith('--connection')), 'custom selector must not reach the native CLI');
      if (tool === 'mysql') assert.equal(result.args[0], '--no-defaults', 'MySQL must read only the role-scoped login file');
      if (tool === 'kubectl') assert.ok(result.credential.includes('name: dev') && result.credential.includes('name: prod'), 'kubectl must receive both contexts from one merged config');
    }
    assert.deepEqual(requests.map(item => item.args[0]), ['--login-path=reporting', '--login-path=warehouse', '--context=dev', '--context=prod']);
    assert.deepEqual(outputs.slice(0, 2).map(item => item.credential), [credentials.mysql.content, credentials.mysql.content]);
    assert.deepEqual(outputs.slice(2).map(item => item.credential), [credentials.kubectl.content, credentials.kubectl.content]);
    assert.ok(outputs.every(item => !JSON.stringify(item).includes('--connection=')), 'native CLI output must not include custom selector arguments');
    assert.ok(outputs.every(item => !item.credentialPath.includes('/.cocell/connections/')), 'native tools must not read per-credential files');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('authorization errors show bounded sanitized 4xx details and hide malformed or server-error bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-auth-error-'));
  const binaryRoot = join(root, 'bin'); await mkdir(binaryRoot);
  await writeFile(join(binaryRoot, 'kubectl'), `#!${process.execPath}\nprocess.exit(99);\n`, { mode: 0o755 });
  const config = { mode: 'home', boxId: 'box-one', url: 'http://broker.example.test' };
  const baseOptions = { config, homeRoot: root, binaryRoot, stdout: { write() {} }, stderr: { write() {} } };
  const authorize = (fetch) => runProtectedTool('kubectl', ['get', 'pods'], { ...baseOptions, fetch });
  try {
    const controls = `line\nsecret\u0000token`;
    const longDetail = `x`.repeat(1500);
    const detailFetch = async () => Response.json({ error: `${controls}${longDetail}` }, { status: 403 });
    await assert.rejects(authorize(detailFetch), error => {
      assert.ok(error instanceof ToolAuthorizationError);
      assert.match(error.message, /^Tool authorization failed \(HTTP 403\): line secret tokenx+$/);
      assert.ok(error.message.length <= 'Tool authorization failed (HTTP 403): '.length + 1024);
      return true;
    });
    for (const response of [
      new Response('{not-json', { status: 403, headers: { 'content-type': 'application/json' } }),
      new Response('internal secret body', { status: 500, headers: { 'content-type': 'text/plain' } }),
      Response.json({ error: 'server secret detail' }, { status: 500 }),
    ]) {
      await assert.rejects(authorize(async () => response.clone()), error => {
        assert.ok(error instanceof ToolAuthorizationError);
        assert.match(error.message, /Tool authorization failed \(HTTP (403|500)\)$/);
        assert.doesNotMatch(error.message, /secret|not-json/);
        return true;
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('unsupported runtime modes fail before credential access or native execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-unsupported-runtime-'));
  const marker = join(root, 'executed');
  await writeFile(join(root, 'mysql'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`, { mode: 0o755 });
  try {
    await assert.rejects(runProtectedTool('mysql', ['-e', 'SELECT 1'], {
      config: { mode: 'files', files: [{ path: '/must-not-be-read' }] }, binaryRoot: root,
    }), /Unsupported tool runtime mode 'files'/);
    assert.equal(await readFile(marker, 'utf8').catch(() => ''), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
