import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeWorkingDirectory, decodeWorkingDirectory } from '../../util/tool-working-directory.mjs';
import { runProtectedTool } from '../../deploy/box-wrap/protected-tool.mjs';

test('all dynamic tools carry a caller directory confined to the real agent HOME', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-cwd-'));
  const home = join(root, 'agent'), repo = join(home, 'repo with spaces'), outside = join(root, 'outside');
  await mkdir(repo, { recursive: true }); await mkdir(outside); await symlink(outside, join(home, 'escape'));
  try {
    const args = encodeWorkingDirectory(['--context=staging', 'get', 'pods'], repo);
    assert.deepEqual(args, [`--cocell-working-directory=${repo}`, '--context=staging', 'get', 'pods']);
    assert.deepEqual(await decodeWorkingDirectory(args, home), { cwd: repo, args: ['--context=staging', 'get', 'pods'] });
    for (const path of [outside, join(home, 'escape')]) {
      await assert.rejects(decodeWorkingDirectory(encodeWorkingDirectory(['status'], path), home), /outside the agent HOME/);
    }
    assert.throws(() => encodeWorkingDirectory([], '../repo'), /Invalid tool working directory/);
    assert.deepEqual(await decodeWorkingDirectory(['status'], home), { args: ['status'] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generic dynamic execution preserves cwd across git cache operations and Go VCS metadata', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-go-cwd-'));
  const home = join(root, 'agent'), repo = join(home, 'workspace/repo'), binaryRoot = join(root, 'native'), proxies = join(root, 'proxy');
  await mkdir(repo, { recursive: true }); await mkdir(binaryRoot); await mkdir(proxies);
  await symlink('/usr/bin/git', join(binaryRoot, 'git'));
  const config = { mode: 'home', boxId: 'box-test', url: 'http://broker.invalid' };
  let output = '';
  const options = { config, agentHome: home, binaryRoot, stdout: { write(s) { output += s; } },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert(body.args.every(arg => !arg.startsWith('--cocell-')), 'transport metadata must be removed before authorization');
      return Response.json({ tool: 'git', args: body.args, home: '/home/debug',
        execution: { executable: '/usr/bin/git', args: [], env: {}, timeoutMs: 20000 } });
    },
  };
  const git = async (cwd, args) => {
    output = '';
    assert.equal(await runProtectedTool('git', encodeWorkingDirectory(args, cwd), options), 0);
    return output.trim();
  };
  try {
    // These cwd-dependent operations are also used by Go's codehost cache.
    for (const name of ['module-one', 'module-two']) {
      const cache = join(home, 'go/pkg/mod/cache/vcs', name); await mkdir(cache, { recursive: true });
      await git(cache, ['init', '--bare']);
      await git(cache, ['remote', 'add', 'origin', 'https://git.example/' + name]);
      assert.equal(await git(cache, ['remote', 'get-url', 'origin']), 'https://git.example/' + name);
      assert.match(await readFile(join(cache, 'config'), 'utf8'), /bare = true/);
    }
    await writeFile(join(repo, 'go.mod'), 'module example.test/cwd\n\ngo 1.22\n');
    await writeFile(join(repo, 'main.go'), 'package main\nfunc main() {}\n');
    await git(repo, ['init']); await git(repo, ['add', 'go.mod', 'main.go']);
    await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
    const childDirectory = join(repo, 'nested'); await mkdir(childDirectory);
    assert.deepEqual(await decodeWorkingDirectory(encodeWorkingDirectory(['status'], childDirectory), home),
      { cwd: childDirectory, args: ['status'] });
    assert.equal(await git(childDirectory, ['rev-parse', '--show-toplevel']), repo);

    const proxy = `#!${process.execPath}\n` +
      `import {runProtectedTool} from ${JSON.stringify(new URL('../../deploy/box-wrap/protected-tool.mjs', import.meta.url).href)};\n` +
      `import {encodeWorkingDirectory} from ${JSON.stringify(new URL('../../util/tool-working-directory.mjs', import.meta.url).href)};\n` +
      `process.exitCode=await runProtectedTool('git',encodeWorkingDirectory(process.argv.slice(2),process.cwd()),{config:${JSON.stringify(config)},agentHome:${JSON.stringify(home)},binaryRoot:${JSON.stringify(binaryRoot)},fetch:async(_url,init)=>{const body=JSON.parse(init.body);return Response.json({tool:'git',args:body.args,home:'/home/debug',execution:{executable:'/usr/bin/git',args:[],env:{},timeoutMs:20000}});}});\n`;
    await writeFile(join(proxies, 'git'), proxy, { mode: 0o755 });
    const goEnv = { ...process.env, PATH: proxies + ':' + process.env.PATH, GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOWORK: 'off' };
    delete goEnv.GOROOT;
    const built = spawnSync('go', ['build', '-buildvcs=true', '-o', join(root, 'app'), '.'], {
      cwd: repo, encoding: 'utf8', timeout: 60000, env: goEnv,
    });
    assert.equal(built.status, 0, built.stderr || String(built.error));
    const metadata = spawnSync('go', ['version', '-m', join(root, 'app')], { encoding: 'utf8', env: goEnv });
    assert.match(metadata.stdout, /vcs=git/); assert.match(metadata.stdout, /vcs.revision=/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
