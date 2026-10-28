import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from '../support/fixtures.mjs';

const exec = promisify(execFile);
let ownedProjectId;
let ownedRoleId;

test.afterEach(async ({ environment: env }) => {
  if (!ownedProjectId && !ownedRoleId) return;
  try {
    if (ownedProjectId)
      await env.json(`/api/projects/${ownedProjectId}/tool-role`, { method: 'PUT', body: { roleId: null } });
  } finally {
    if (ownedRoleId) await env.json(`/api/tool-roles/${ownedRoleId}`, { method: 'DELETE' });
    ownedProjectId = undefined;
    ownedRoleId = undefined;
  }
});

test('deployed Git proxy preserves nested repository and Go module-cache directories', async ({ environment: env }) => {
  test.skip(process.env.COCELL_E2E_TOOL_CWD_TEST !== '1', 'Requires a rebuilt HOME image with Git, Go and configured Git credentials');
  test.setTimeout(600_000);
  const context = process.env.COCELL_E2E_KUBE_CONTEXT;
  assert(context);
  const images = await env.json('/api/images');
  const image = images.find(item => item.name === (process.env.COCELL_E2E_TOOL_HOME_IMAGE ?? 'mybox'));
  assert(image?.defaultVersionId);
  const created = await env.json('/api/projects', { method: 'POST', expectedStatus: 201,
    body: { name: env.name('tool-cwd'), type: 1, imageId: image.id, imageVersionId: image.defaultVersionId } });
  ownedProjectId = created.id;
  const project = await env.waitProject(created.id, { kind: 'create', status: 'ready' });
  const git = (await env.json('/api/tool-definitions')).find(tool => tool.name === 'git' && tool.enabled);
  assert(git, 'Configure an enabled dynamic Git tool');
  const role = await env.json('/api/tool-roles', { method: 'POST', expectedStatus: 201, body: { name: env.name('git-cwd-role'),
    permissions: [{ tool: 'git', enabled: true }] } });
  ownedRoleId = role.id;
  await env.json(`/api/projects/${project.id}/tool-role`, { method: 'PUT', body: { roleId: role.id } });
  const namespace = process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box';
  const resources = JSON.parse((await exec('kubectl', ['--context', context, '-n', namespace, 'get', 'cellboxes',
    '-l', `cellbox.local/box-id=${project.sandbox.id}`, '-o', 'json'])).stdout);
  assert.equal(resources.items.length, 1);
  const pod = resources.items[0].status.podName;
  assert(pod);
  const code = `
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const root='/home/agent/workspace/tool-cwd-regression',repo=root+'/repo';
fs.mkdirSync(repo,{recursive:true});fs.chownSync(root,11000,11000);fs.chownSync(repo,11000,11000);
function run(cmd,args,cwd=repo){const r=spawnSync(cmd,args,{cwd,uid:11000,gid:11000,encoding:'utf8',timeout:240000,env:{HOME:'/home/agent',PATH:'/var/lib/cellbox/shared/tools/current/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin',GOTOOLCHAIN:'local',GOPROXY:'off',GOSUMDB:'off'}});if(r.status!==0)throw new Error(cmd+' '+args.join(' ')+': '+r.stderr);return r.stdout.trim();}
for(const name of ['cache-one','cache-two']){const cwd=root+'/'+name;fs.mkdirSync(cwd);fs.chownSync(cwd,11000,11000);run('git',['init','--bare'],cwd);run('git',['remote','add','origin','https://example.invalid/'+name],cwd);if(run('git',['remote','get-url','origin'],cwd)!=='https://example.invalid/'+name)throw new Error('Wrong cache directory');}
fs.writeFileSync(repo+'/go.mod','module example.test/cwd\\ngo 1.22\\n');fs.writeFileSync(repo+'/main.go','package main\\nfunc main() {}\\n');
for(const name of ['go.mod','main.go'])fs.chownSync(repo+'/'+name,11000,11000);
run('git',['init']);run('git',['add','.']);run('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
const nested=repo+'/nested';fs.mkdirSync(nested);fs.chownSync(nested,11000,11000);if(run('git',['rev-parse','--show-toplevel'],nested)!==repo)throw new Error('Wrong repository');
run('go',['build','-buildvcs=true','-o',root+'/app','.']);const metadata=run('go',['version','-m',root+'/app']);if(!metadata.includes('vcs.revision='))throw new Error('Missing Git revision');
console.log(JSON.stringify({repository:repo,metadata}));`;
  // Codex runs `bash -lc` with its apply_patch alias directory first in the inherited PATH.
  const loginPath = `const r=require('node:child_process').spawnSync('/bin/bash',['-lc','printf %s "$PATH"'],{uid:11000,gid:11000,encoding:'utf8',env:{HOME:'/home/agent',PATH:'/cocell-e2e-inherited:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin'}});if(r.status!==0)throw new Error(r.stderr);console.log(r.stdout);`;
  const shellPath = (await exec('kubectl', ['--context', context, '-n', namespace, 'exec', pod, '--', '/usr/local/bin/node', '-e', loginPath], { timeout: 40_000 })).stdout.trim().split(':');
  assert.equal(shellPath[0], '/var/lib/cellbox/shared/tools/current/bin');
  assert(shellPath.includes('/cocell-e2e-inherited') && shellPath.includes('/usr/local/go/bin'), `Login shell dropped inherited PATH: ${shellPath.join(':')}`);
  try {
    const result = await exec('kubectl', ['--context', context, '-n', namespace, 'exec', pod, '--', '/usr/local/bin/node', '-e', code], { timeout: 500_000, maxBuffer: 1024 * 1024 });
    const evidence = JSON.parse(result.stdout);
    assert.match(evidence.metadata, /vcs=git/);
    await test.info().attach('git-cwd-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } finally {
    await env.json(`/api/projects/${project.id}/tool-role`, { method: 'PUT', body: { roleId: null } });
  }
});
