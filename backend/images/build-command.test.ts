import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { prepareImageRequest } from './build-command.js';

test('managed image payload resolves both proxy entrypoints and their shared imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-image-modules-'));
  try {
    const request = await prepareImageRequest('registry.example/mybox:1');
    const payload = request.buildCommand.match(/([A-Za-z0-9+/]{100,}={0,2})/)?.[1];
    assert(payload, 'Compressed proxy payload must be present');
    const files = JSON.parse(gunzipSync(Buffer.from(payload, 'base64')).toString()) as {path: string; content: string}[];
    for (const file of files) {
      const destination = join(root, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
    const product = join(root, 'opt/product/cocell');
    const shippedPaths = files.map(file => file.path);
    assert.equal(shippedPaths.some(path => path.includes('oss-archive-backup') || path.includes('cocell-archive-backup')), false,
      'new images must not include the removed OSS archive generator');
    assert(shippedPaths.includes('/opt/product/cocell/oss-archive-restore.mjs'), 'legacy OSS archive restore remains available');
    assert(shippedPaths.includes('/opt/cellbox/tools/cocell-archive-restore'), 'legacy restore protected tool remains available');
    for (const name of ['protected-tool', 'tool-client']) {
      await symlink(`deploy/box-wrap/${name}.mjs`, join(product, `${name}.mjs`));
    }
    const module = await import(pathToFileURL(join(product, 'protected-tool.mjs')).href);
    assert.equal(typeof module.runProtectedTool, 'function');
    const client = await readFile(join(product, 'tool-client.mjs'), 'utf8');
    const imported = client.match(/from '([^']+gitlab-tool-host\.mjs)'/)?.[1];
    assert(imported);
    const hostModule = await import(pathToFileURL(join(product, 'deploy/box-wrap', imported)).href);
    assert.deepEqual(hostModule.encodeGitlabHost('cocell_glab', ['repo', 'clone', 'group/repo'], 'git.example'),
      ['--cocell-gitlab-host=git.example', 'repo', 'clone', 'group/repo']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
