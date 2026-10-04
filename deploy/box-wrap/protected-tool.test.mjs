import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runProtectedTool } from './protected-tool.mjs';
import { openMeegleBundle, rebindMeegleBundle } from './credential-files.mjs';
import { meegleFixture } from './meegle-test-fixture.mjs';

test('Meegle native file group rebinds, redacts tokens and retries complete refreshed groups with advancing versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-meegle-files-'));
  const binaryRoot = join(root, 'bin'), tempRoot = join(root, 'homes'); await mkdir(binaryRoot);
  const source = meegleFixture();
  await writeFile(join(binaryRoot, 'meegle'), `#!${process.execPath}
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const home=path.join(process.env.HOME,'.meegle'),filename=path.join(home,'credentials.enc');
const machineKey=fs.readFileSync(path.join(home,'.machine-key'),'utf8');
const encrypted=JSON.parse(fs.readFileSync(filename,'utf8'));
const derive=salt=>crypto.pbkdf2Sync(os.hostname()+':'+process.env.USER+':'+machineKey+':meegle-cli',salt,100000,32,'sha256');
const decipher=crypto.createDecipheriv('aes-256-gcm',derive(Buffer.from(encrypted.salt,'hex')),Buffer.from(encrypted.iv,'hex'));decipher.setAuthTag(Buffer.from(encrypted.tag,'hex'));
const data=JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data,'hex')),decipher.final()]).toString());
console.log(data.access_token);console.log(data.refresh_token);
if(process.argv[2]==='refresh'){
 data.access_token='access-refreshed';data.refresh_token='refresh-refreshed';data.expires_at+=1000;
 const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',derive(salt),iv);
 const bytes=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final()]);
 fs.writeFileSync(filename,JSON.stringify({salt:salt.toString('hex'),iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:bytes.toString('hex')}));
 console.log(data.access_token);console.log(data.refresh_token);
}
console.log('native files work');
process.exit(process.argv[2]==='refresh'?1:0);
`, { mode: 0o755 });
  let output = '', requests = 0; const sink = { write(value) { output += value; } }, updates = [];
  const config = { mode: 'files', generation: 1, url: 'http://unused.invalid', token: 'runtime-secret', files: [{ tool: 'meegle', path: source.files[0].path, secretId: 'group-secret', format: 'files', version: 1, mutable: true, content: Buffer.from(JSON.stringify(source)).toString('base64') }] };
  const options = { config, binaryRoot, tempRoot, stdout: sink, stderr: sink,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body); requests++; assert.equal(body.updates.length, 1);
      const update = body.updates[0], bundle = JSON.parse(Buffer.from(update.content, 'base64').toString());
      assert.equal(bundle.files.length, 3); assert.equal(bundle.identity.username, 'unknown');
      const data = openMeegleBundle(bundle); updates.push({ update, data });
      if (requests === 1) throw new Error('offline');
      return Response.json({ saved: true, versions: [{ secretId: 'group-secret', version: update.baseVersion + 1 }] });
    },
  };
  try {
    assert.equal(await runProtectedTool('meegle', ['read'], options), 0);
    assert.equal(requests, 0, 'Re-encryption alone must not commit a central version');
    assert.equal(await runProtectedTool('meegle', ['refresh'], options), 1);
    assert.equal(requests, 1); assert.equal(updates[0].data.refresh_token, 'refresh-refreshed');
    assert.equal(await runProtectedTool('meegle', ['read'], options), 0);
    assert.equal(updates[1].update.baseVersion, 1);
    assert.equal(await runProtectedTool('meegle', ['refresh'], options), 1);
    assert.equal(updates[2].update.baseVersion, 2);
    assert.equal(await runProtectedTool('meegle', ['read'], options), 0);
    assert.equal(requests, 3);
    assert.ok(output.includes('native files work')); assert.ok(output.includes('local files retained'));
    for (const secret of ['access-original', 'refresh-original', 'access-refreshed', 'refresh-refreshed']) assert.ok(!output.includes(secret));
    const restored = JSON.parse(updates.at(-1).update.content ? Buffer.from(updates.at(-1).update.content, 'base64').toString() : '{}');
    const restoredConfig = { ...config, generation: 2, files: [{ ...config.files[0], version: 3, content: Buffer.from(JSON.stringify(restored)).toString('base64') }] };
    assert.equal(await runProtectedTool('meegle', ['read'], { ...options, config: restoredConfig }), 0);
    assert.equal(requests, 3);
    // Simulate an interrupted rebind on another host. Recovery must finish the
    // journal before interpreting a partially replaced native file group.
    const migrated = rebindMeegleBundle(restored, { hostname: 'previous-sandbox-host', username: 'unknown' });
    const snapshot = createHash('sha256').update(JSON.stringify({ generation: config.generation, resource: config.files[0] })).digest('hex');
    const state = join(tempRoot, 'meegle', snapshot);
    await writeFile(join(state, 'pending.json'), JSON.stringify(migrated), { mode: 0o600 });
    await writeFile(join(state, 'home', '.meegle/.machine-key'), migrated.files[1].content, { mode: 0o600 });
    assert.equal(await runProtectedTool('meegle', ['read'], options), 0);
    assert.equal(requests, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provisioned local files survive repeated calls, writeback failure and central deletion without authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-local-files-'));
  const binaryRoot = join(root, 'bin'), tempRoot = join(root, 'homes');
  await mkdir(binaryRoot);
  const raw = '\uFEFF{"access_token":"local-original","refresh_token":"refresh-original"}\r\n';
  const path = '.config/测试工具/auth file.json';
  const refreshed = '{"access_token":"local-refreshed","refresh_token":"refresh-next"}';
  await writeFile(join(binaryRoot, 'custom.cli'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const file=path.join(process.env.HOME,${JSON.stringify(path)}),raw=fs.readFileSync(file,'utf8');
if(raw!==(process.argv[2]==='refresh'?${JSON.stringify(raw)}:${JSON.stringify(refreshed)}))process.exit(2);
if(process.argv[2]==='refresh')fs.writeFileSync(file,${JSON.stringify(refreshed)});
console.log('local-refreshed');console.log('refresh-original');console.log('local tool works');
`, { mode: 0o755 });
  let output = '', requests = 0;
  const sink = { write(value) { output += value; } };
  const options = { config: { mode: 'files', generation: 1, url: 'http://unused.invalid', token: 'runtime-secret', files: [{ tool: 'custom.cli', path, secretId: 'local-secret', version: 1, mutable: true, content: Buffer.from(raw).toString('base64') }] }, binaryRoot, tempRoot, stdout: sink, stderr: sink,
    fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, '/api/tool-runtime/files');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.updates, [{ secretId: 'local-secret', content: Buffer.from(refreshed).toString('base64'), baseVersion: 1 }]);
      requests++;
      if (requests === 1) throw new Error('offline');
      return Response.json({ saved: false, discarded: true });
    },
  };
  try {
    assert.equal(await runProtectedTool('custom.cli', ['refresh'], options), 0);
    assert.equal(requests, 1);
    assert.ok(output.includes('local file retained for retry'));
    assert.equal(await runProtectedTool('custom.cli', ['read'], options), 0);
    assert.equal(requests, 2);
    assert.equal(await runProtectedTool('custom.cli', ['read'], options), 0);
    assert.equal(requests, 2);
    const snapshots = await readdir(join(tempRoot, 'custom.cli'));
    assert.equal(await readFile(join(tempRoot, 'custom.cli', snapshots[0], 'home', path), 'utf8'), refreshed);
    assert.ok(output.includes('local tool works'));
    assert.ok(!output.includes('local-refreshed') && !output.includes('refresh-original'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tools with no selected file run locally without broker requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-no-file-'));
  await writeFile(join(root, 'custom.cli'), `#!${process.execPath}\nconsole.log('tool version 1');\n`, { mode: 0o755 });
  let output = '';
  const options = { config: { mode: 'files', generation: 1, files: [], url: 'http://unused.invalid', token: 'runtime-secret' }, binaryRoot: root, tempRoot: join(root, 'homes'), stdout: { write(value) { output += value; } },
    fetch: async () => { assert.fail('CLI execution must not request authorization'); },
  };
  try {
    assert.equal(await runProtectedTool('custom.cli', ['--version'], options), 0);
    assert.equal(output, 'tool version 1\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parallel CLI calls get isolated files and persist refreshes after business failure without leaking tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-secret-runner-'));
  const binaryRoot = join(root, 'bin'), tempRoot = join(root, 'runs');
  await mkdir(binaryRoot);
  const raw = '\uFEFF{"access_token":"access-original","refresh_token":"refresh-original"}\r\n';
  await writeFile(join(binaryRoot, 'meegle'), `#!${process.execPath}
const fs=require('fs'),path=require('path');
const target=path.join(process.env.HOME,'.meegle/credentials.json');
const raw=fs.readFileSync(target,'utf8');
if(raw!==${JSON.stringify(raw)})process.exit(2);
const previous=JSON.parse(raw.replace(/^\uFEFF/,''));
setTimeout(()=>{fs.writeFileSync(target+'.tmp',JSON.stringify({access_token:'access-new-'+process.argv[2],refresh_token:'refresh-new-'+process.argv[2]}));fs.renameSync(target+'.tmp',target);console.log(previous.access_token);console.log(previous.refresh_token);console.log('access-new-'+process.argv[2]);console.log('refresh-new-'+process.argv[2]);process.exit(process.argv[2]==='fail'?1:0)},20);
`, { mode: 0o755 });
  const completions = [], homes = []; let count = 0; let output = '';
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (String(_url).endsWith('/start')) {
      assert.deepEqual(body.args, [body.args[0]]); assert.equal(body.alias, undefined);
      return Response.json({ id: String(++count), tool: 'meegle', args: body.args, files: [{ secretId: 'secret', version: 1, path: '.meegle/credentials.json', mutable: true, content: Buffer.from(raw).toString('base64') }] });
    }
    completions.push(body); homes.push(...await readdir(tempRoot)); return Response.json({ saved: true });
  };
  const sink = { write(value) { output += value; } };
  try {
    const options = { config: { url: 'http://unused.invalid', token: 'runtime-token-secret' }, fetch, binaryRoot, tempRoot, stdout: sink, stderr: sink };
    const codes = await Promise.all([runProtectedTool('meegle', ['ok'], options), runProtectedTool('meegle', ['fail'], options)]);
    assert.deepEqual(codes, [0, 1]); assert.equal(completions.length, 2);
    assert.equal(new Set(homes).size, 2);
    assert.deepEqual(completions.map(item => JSON.parse(Buffer.from(item.updates[0].content, 'base64').toString()).refresh_token).sort(), ['refresh-new-fail', 'refresh-new-ok']);
    assert.ok(!output.includes('refresh-') && !output.includes('access-')); assert.ok(output.includes('[REDACTED]'));
    assert.deepEqual(await readdir(tempRoot), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('custom tools read raw text from arbitrary safe HOME paths without a fixed tool registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-custom-runner-'));
  const binaryRoot = join(root, 'bin'), tempRoot = join(root, 'runs');
  await mkdir(binaryRoot);
  const raw = '# 保留原文\r\naccess_token: original-secret\r\n';
  await writeFile(join(binaryRoot, 'custom.cli'), `#!${process.execPath}
const fs=require('fs'),path=require('path');
const file=path.join(process.env.HOME,'.config/自定义工具/auth.yaml');
if(fs.readFileSync(file,'utf8')!==${JSON.stringify(raw)})process.exit(2);
fs.writeFileSync(file,'access_token: refreshed-secret\\n');
console.log('original-secret');console.log('refreshed-secret');console.log('custom tool works');
`, { mode: 0o755 });
  let output = '', completed;
  const options = { config: { url: 'http://unused.invalid', token: 'runtime-secret' }, binaryRoot, tempRoot,
    stdout: { write(value) { output += value; } }, stderr: { write(value) { output += value; } },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith('/start')) {
        assert.equal(body.tool, 'custom.cli');
        return Response.json({ id: 'custom', tool: body.tool, args: body.args, files: [{ path: '.config/自定义工具/auth.yaml', secretId: 'custom-secret', version: 1, mutable: true, content: Buffer.from(raw).toString('base64') }] });
      }
      completed = body; return Response.json({ saved: true });
    },
  };
  try {
    assert.equal(await runProtectedTool('custom.cli', ['inspect'], options), 0);
    assert.equal(Buffer.from(completed.updates[0].content, 'base64').toString(), 'access_token: refreshed-secret\n');
    assert.ok(output.includes('custom tool works'));
    assert.ok(!output.includes('original-secret') && !output.includes('refreshed-secret'));
    assert.deepEqual(await readdir(tempRoot), []);
    await assert.rejects(runProtectedTool('../tool', [], options), /Invalid protected tool/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('acknowledging a deleted resource discards refreshed files with existing runner behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-deleted-resource-'));
  const binaryRoot = join(root, 'bin'), tempRoot = join(root, 'runs');
  await mkdir(binaryRoot);
  await writeFile(join(binaryRoot, 'custom.cli'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(process.env.HOME,'auth.json'),'{"refresh_token":"refreshed-after-deletion"}');
console.log('refreshed-after-deletion');
`, { mode: 0o755 });
  let completed = false, output = '';
  const options = { config: { url: 'http://unused.invalid', token: 'runtime-secret' }, binaryRoot, tempRoot,
    stdout: { write(value) { output += value; } }, stderr: { write(value) { output += value; } },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith('/start')) return Response.json({ id: 'deleted', tool: body.tool, args: body.args, files: [{ path: 'auth.json', secretId: 'deleted-secret', version: 1, mutable: true, content: Buffer.from('{"refresh_token":"original"}').toString('base64') }] });
      assert.equal(body.updates[0].secretId, 'deleted-secret');
      completed = true;
      return Response.json({ saved: false, discarded: true });
    },
  };
  try {
    assert.equal(await runProtectedTool('custom.cli', [], options), 0);
    assert.equal(completed, true);
    assert.ok(output.includes('[REDACTED]') && !output.includes('refreshed-after-deletion'));
    assert.deepEqual(await readdir(tempRoot), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('arbitrary credential directories preserve binary files and sync additions and deletions as one version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-directory-'));
  const binaryRoot = join(root, 'bin'), tempRoot = join(root, 'homes'); await mkdir(binaryRoot);
  const directory = '.config/custom', binary = Buffer.from([0, 255, 128, 10]);
  const source = { directory, files: [{ path: `${directory}/config.json`, content: '\uFEFF{"token":"directory-original"}\r\n' }, { path: `${directory}/keys/old`, content: binary.toString('base64'), encoding: 'base64' }, { path: `${directory}/empty`, content: '' }] };
  await writeFile(join(binaryRoot, 'custom.cli'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const dir=path.join(process.env.HOME,'.config/custom');
if(fs.readFileSync(path.join(dir,'empty')).length)process.exit(2);
if(process.argv[2]==='refresh'){
 if(!fs.readFileSync(path.join(dir,'keys/old')).equals(Buffer.from([0,255,128,10])))process.exit(3);
 fs.unlinkSync(path.join(dir,'keys/old'));
 fs.writeFileSync(path.join(dir,'keys/new'),Buffer.from([255,0,129,13]));
 fs.writeFileSync(path.join(dir,'config.json'),' {"token":"directory-refreshed"}\\r\\n');
 fs.writeFileSync(path.join(process.env.HOME,'outside'),'unrelated');
}
if(process.argv[2]==='link')fs.symlinkSync('/etc/passwd',path.join(dir,'link'));
console.log(JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8').replace(/^\\uFEFF/, '')).token);console.log('directory works');
`, { mode: 0o755 });
  const config = { mode: 'files', generation: 1, url: 'http://unused.invalid', token: 'runtime-secret', files: [{ tool: 'custom.cli', path: source.files[0].path, secretId: 'directory-secret', format: 'files', version: 1, mutable: true, content: Buffer.from(JSON.stringify(source)).toString('base64') }] };
  let output = '', requests = 0, saved;
  const sink = { write(value) { output += value; } };
  const options = { config, binaryRoot, tempRoot, stdout: sink, stderr: sink, fetch: async (_url, init) => {
    requests++; const body = JSON.parse(init.body); assert.equal(body.updates.length, 1);
    const update = body.updates[0]; assert.equal(update.baseVersion, 1);
    saved = JSON.parse(Buffer.from(update.content, 'base64').toString());
    assert.equal(saved.directory, directory); assert.equal(saved.files.length, 3);
    assert.ok(!saved.files.some(file => file.path.endsWith('/old') || file.path === 'outside'));
    assert.deepEqual(Buffer.from(saved.files.find(file => file.path.endsWith('/new')).content, 'base64'), Buffer.from([255, 0, 129, 13]));
    return Response.json({ saved: true, versions: [{ secretId: 'directory-secret', version: 2 }] });
  } };
  try {
    assert.equal(await runProtectedTool('custom.cli', ['read'], options), 0); assert.equal(requests, 0);
    assert.equal(await runProtectedTool('custom.cli', ['refresh'], options), 0); assert.equal(requests, 1);
    assert.equal(await runProtectedTool('custom.cli', ['read'], options), 0); assert.equal(requests, 1);
    const restored = { ...config, generation: 2, files: [{ ...config.files[0], version: 2, content: Buffer.from(JSON.stringify(saved)).toString('base64') }] };
    assert.equal(await runProtectedTool('custom.cli', ['read'], { ...options, config: restored }), 0); assert.equal(requests, 1);
    assert.ok(output.includes('directory works')); assert.ok(!output.includes('directory-refreshed'));
    await assert.rejects(runProtectedTool('custom.cli', ['link'], options), /符号链接/);
    assert.equal(requests, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
