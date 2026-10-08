import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeWorkingDirectory, decodeWorkingDirectory } from '../../util/tool-working-directory.mjs';
import { encodeGitlabHost } from '../../util/gitlab-tool-host.mjs';
import { runProtectedTool } from '../../deploy/box-wrap/protected-tool.mjs';

test('caller directory is confined to real agent HOME directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-cwd-'));
  const home = join(root, 'agent'), repo = join(home, 'repo with spaces'), debug = join(root, 'debug');
  await mkdir(repo, { recursive: true }); await mkdir(debug);
  await symlink(debug, join(home, 'escape'));
  try {
    const args = encodeWorkingDirectory('cocell_glab', encodeGitlabHost('cocell_glab', ['api', 'user'], 'git.example'), repo);
    const decoded = await decodeWorkingDirectory('glab', args, home);
    assert.deepEqual(decoded, {
      cwd: repo, args: ['--cocell-gitlab-host=git.example', 'api', 'user'],
      gitEnv: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: repo },
    });
    for (const path of [debug, join(home, 'escape')]) {
      await assert.rejects(decodeWorkingDirectory('git', encodeWorkingDirectory('git', [], path), home), /outside the agent HOME/);
    }
    assert.throws(() => encodeWorkingDirectory('git', [], '../repo'), /Invalid tool working directory/);
    assert.deepEqual(await decodeWorkingDirectory('git', ['status'], home), { args: ['status'] });
    assert.deepEqual(encodeWorkingDirectory('mysql', ['--version'], repo), ['--version']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git cache initialization and native Go VCS builds retain the caller directory across the proxy', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-go-cwd-'));
  const home = join(root, 'agent'), repo = join(home, 'workspace/repo'), binaryRoot = join(root, 'native'), proxies = join(root, 'proxy');
  await mkdir(repo, { recursive: true }); await mkdir(binaryRoot); await mkdir(proxies);
  await symlink('/usr/bin/git', join(binaryRoot, 'git'));
  const config = { mode: 'home', boxId: 'box-test', url: 'http://broker.invalid' };
  let output = '';
  const options = { config, agentHome: home, binaryRoot, stdout: { write(s) { output += s; } },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert(body.args.every(arg => !arg.startsWith('--cocell-')));
      return Response.json({ tool: 'git', args: body.args, home: '/home/debug/00000000-0000-0000-0000-000000000000', path: '.gitconfig' });
    },
  };
  const git = async (cwd, args) => {
    output = '';
    assert.equal(await runProtectedTool('git', encodeWorkingDirectory('git', args, cwd), options), 0);
    return output.trim();
  };
  try {
    // These are the same cwd-dependent operations used by Go's codehost cache.
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
    const childInvocation = await decodeWorkingDirectory('git', encodeWorkingDirectory('git', ['status'], childDirectory), home);
    assert.equal(childInvocation.gitEnv.GIT_CONFIG_VALUE_0, repo);
    for (const format of ['text', 'files']) {
      output = '';
      const path = '.gitconfig';
      const content = format === 'text' ? '[user]\nname=Test\n' : JSON.stringify({ files: [{ path, content: '[user]\nname=Test\n' }] });
      assert.equal(await runProtectedTool('git', encodeWorkingDirectory('git', ['rev-parse', '--show-toplevel'], childDirectory), {
        ...options, tempRoot: join(root, 'legacy', format), config: { mode: 'files', generation: 1, url: config.url,
          files: [{ tool: 'git', path, format, secretId: 'git', version: 1, mutable: false, content: Buffer.from(content).toString('base64') }] },
      }), 0);
      assert.equal(output.trim(), repo);
    }
    const proxy = `#!${process.execPath}\n` +
      `import {runProtectedTool} from ${JSON.stringify(new URL('../../deploy/box-wrap/protected-tool.mjs', import.meta.url).href)};\n` +
      `import {encodeWorkingDirectory} from ${JSON.stringify(new URL('../../util/tool-working-directory.mjs', import.meta.url).href)};\n` +
      `process.exitCode=await runProtectedTool('git',encodeWorkingDirectory('git',process.argv.slice(2),process.cwd()),{config:${JSON.stringify(config)},agentHome:${JSON.stringify(home)},binaryRoot:${JSON.stringify(binaryRoot)},fetch:async(_url,init)=>{const body=JSON.parse(init.body);return Response.json({tool:'git',args:body.args,home:'/home/debug/00000000-0000-0000-0000-000000000000',path:'.gitconfig'});}});\n`;
    await writeFile(join(proxies, 'git'), proxy, { mode: 0o755 });
    const goEnv = { ...process.env, PATH: proxies + ':' + process.env.PATH, GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOWORK: 'off' };
    // Let the selected Go binary locate its own standard library/toolchain.
    delete goEnv.GOROOT;
    const built = spawnSync('go', ['build', '-buildvcs=true', '-o', join(root, 'app'), '.'], {
      cwd: repo, encoding: 'utf8', timeout: 60000,
      env: goEnv,
    });
    assert.equal(built.status, 0, built.stderr || String(built.error));
    const metadata = spawnSync('go', ['version', '-m', join(root, 'app')], { encoding: 'utf8', env: goEnv });
    assert.match(metadata.stdout, /vcs=git/); assert.match(metadata.stdout, /vcs.revision=/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
