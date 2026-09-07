import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { loadAgentDocs } from '../server/agent-docs.js';

test('shared docs preserve nested names and bytes without publishing adjacent files or following symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-agent-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', '接口 #1'), { recursive: true });
  await writeFile(join(root, 'private.txt'), 'must not be published');
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  await writeFile(join(root, 'docs', '接口 #1', 'a?.bin'), bytes);
  await writeFile(join(root, 'docs', 'index.txt'), '入口');
  await symlink(join(root, 'private.txt'), join(root, 'docs', 'external.txt'));
  await symlink(root, join(root, 'docs', 'loop'));
  const source = pathToFileURL(join(root, 'docs') + '/');
  const files = await loadAgentDocs(source);
  assert.deepEqual(files.map(file => file.path).sort(), ['index.txt', '接口 #1/a?.bin']);
  assert.deepEqual(new Uint8Array(files.find(file => file.path.endsWith('.bin'))!.contents), bytes);
  await writeFile(join(root, 'docs', 'index.txt'), '更新后的入口');
  await rm(join(root, 'docs', '接口 #1'), { recursive: true });
  const updated = await loadAgentDocs(source);
  assert.equal(updated.length, 1);
  assert.equal(new TextDecoder().decode(updated[0].contents), '更新后的入口');
});
