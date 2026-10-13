import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runProtectedTool } from '../../deploy/box-wrap/protected-tool.mjs';

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

test('mounted HOME forwards named selectors to authorization and runs MySQL and kubectl with only the selected path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-named-home-'));
  const projectId = randomUUID(), homeRoot = join(root, 'homes'), home = join(homeRoot, projectId), binaryRoot = join(root, 'bin');
  await mkdir(binaryRoot); await mkdir(join(home, '.cocell/connections/mysql/mysql-reporting'), { recursive: true });
  await mkdir(join(home, '.cocell/connections/mysql/mysql-warehouse'), { recursive: true });
  await mkdir(join(home, '.cocell/connections/kubectl/kube-dev'), { recursive: true });
  await mkdir(join(home, '.cocell/connections/kubectl/kube-prod'), { recursive: true });
  const credentials = {
    mysql: {
      reporting: { path: '.cocell/connections/mysql/mysql-reporting/config', content: '[client]\\nuser=reporting\\n' },
      warehouse: { path: '.cocell/connections/mysql/mysql-warehouse/config', content: '[client]\\nuser=warehouse\\n' },
    },
    kubectl: {
      dev: { path: '.cocell/connections/kubectl/kube-dev/config', content: 'cluster: dev' },
      prod: { path: '.cocell/connections/kubectl/kube-prod/config', content: 'cluster: prod' },
    },
  };
  for (const [tool, connections] of Object.entries(credentials)) for (const entry of Object.values(connections))
    await writeFile(join(home, entry.path), entry.content);
  await writeFile(join(binaryRoot, 'mysql'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),option=args.find(value=>value.startsWith('--defaults-file='));
console.log(JSON.stringify({credential:fs.readFileSync(option.slice('--defaults-file='.length),'utf8'),args}));
`, { mode: 0o755 });
  await writeFile(join(binaryRoot, 'kubectl'), `#!${process.execPath}
const fs=require('node:fs');
console.log(JSON.stringify({credential:fs.readFileSync(process.env.KUBECONFIG,'utf8'),args:process.argv.slice(2)}));
`, { mode: 0o755 });
  const config = { mode: 'home', boxId: 'box-one', url: 'http://unused.invalid' }, requests = [], outputs = [];
  const options = { config, homeRoot, binaryRoot, stdout: { write(value) { outputs.push(JSON.parse(value)); } }, fetch: async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/tool-runtime/authorize');
    const body = JSON.parse(init.body); requests.push(body);
    const selector = body.args.find(arg => arg.startsWith('--connection='));
    assert.ok(selector, 'the connection selector must reach the broker unchanged');
    const alias = selector.slice('--connection='.length), selected = credentials[body.tool][alias];
    assert.ok(selected, `unexpected ${body.tool} selector ${alias}`);
    return Response.json({ tool: body.tool, args: body.args.filter(arg => arg !== selector), home: `/home/debug/${projectId}`, path: selected.path });
  } };
  try {
    for (const [tool, alias, args, expectedContent] of [
      ['mysql', 'reporting', ['--connection=reporting', '-e', 'SELECT 1'], credentials.mysql.reporting.content],
      ['mysql', 'warehouse', ['--connection=warehouse', '-e', 'SELECT 1'], credentials.mysql.warehouse.content],
      ['kubectl', 'dev', ['--connection=dev', 'get', 'pods'], credentials.kubectl.dev.content],
      ['kubectl', 'prod', ['--connection=prod', 'get', 'pods'], credentials.kubectl.prod.content],
    ]) {
      assert.equal(await runProtectedTool(tool, args, options), 0);
      const result = outputs.at(-1);
      assert.equal(result.credential, expectedContent, `${tool} ${alias} must read the authorized connection file`);
      assert.ok(result.args.every(arg => !arg.startsWith('--connection')), 'selector must not reach the native CLI');
    }
    assert.deepEqual(requests.map(item => item.args[0]), ['--connection=reporting', '--connection=warehouse', '--connection=dev', '--connection=prod']);
    assert.deepEqual(outputs.slice(0, 2).map(item => item.args[0]), [
      `--defaults-file=${join(home, credentials.mysql.reporting.path)}`,
      `--defaults-file=${join(home, credentials.mysql.warehouse.path)}`,
    ]);
    assert.deepEqual(outputs.slice(2).map(item => item.credential), [credentials.kubectl.dev.content, credentials.kubectl.prod.content]);
    assert.ok(outputs.every(item => !JSON.stringify(item).includes('--connection=')), 'native CLI output must not include selector arguments');
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
