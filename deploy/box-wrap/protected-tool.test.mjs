import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runProtectedTool } from './protected-tool.mjs';

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
