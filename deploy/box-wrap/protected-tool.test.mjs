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
  await writeFile(join(binaryRoot, 'meegle'), `#!${process.execPath}
const fs=require('fs'),path=require('path');
const target=path.join(process.env.HOME,'.meegle/credentials.json');
const previous=JSON.parse(fs.readFileSync(target));
setTimeout(()=>{fs.writeFileSync(target+'.tmp',JSON.stringify({access_token:'access-new-'+process.argv[2],refresh_token:'refresh-new-'+process.argv[2]}));fs.renameSync(target+'.tmp',target);console.log(previous.refresh_token);console.log('refresh-new-'+process.argv[2]);process.exit(process.argv[2]==='fail'?1:0)},20);
`, { mode: 0o755 });
  const completions = [], homes = []; let count = 0; let output = '';
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (String(_url).endsWith('/start')) {
      assert.deepEqual(body.args, [body.args[0]]); assert.equal(body.alias, 'dev');
      return Response.json({ id: String(++count), tool: 'meegle', args: body.args, files: [{ secretId: 'secret', version: 1, path: '.meegle/credentials.json', mutable: true, content: Buffer.from('{"refresh_token":"refresh-original"}').toString('base64') }] });
    }
    completions.push(body); homes.push(...await readdir(tempRoot)); return Response.json({ saved: true });
  };
  const sink = { write(value) { output += value; } };
  try {
    const options = { config: { url: 'http://unused.invalid', token: 'runtime-token-secret' }, fetch, binaryRoot, tempRoot, stdout: sink, stderr: sink };
    const codes = await Promise.all([runProtectedTool('meegle', ['--connection=dev', 'ok'], options), runProtectedTool('meegle', ['--connection=dev', 'fail'], options)]);
    assert.deepEqual(codes, [0, 1]); assert.equal(completions.length, 2);
    assert.equal(new Set(homes).size, 2);
    assert.deepEqual(completions.map(item => JSON.parse(Buffer.from(item.updates[0].content, 'base64').toString()).refresh_token).sort(), ['refresh-new-fail', 'refresh-new-ok']);
    assert.ok(!output.includes('refresh-')); assert.ok(output.includes('[REDACTED]'));
    assert.deepEqual(await readdir(tempRoot), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
