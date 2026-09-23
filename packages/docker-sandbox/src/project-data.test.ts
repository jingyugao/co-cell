import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDockerProjectData, resolveDockerProjectData } from './project-data.js';

test('project generations are isolated, owned by the Sandbox user, and reject symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-project-data-'));
  const outside = await mkdtemp(join(tmpdir(), 'cocell-outside-'));
  const projectId = randomUUID();
  try {
    const first = await createDockerProjectData(root, projectId, process.getuid!(), process.getgid!());
    const second = await createDockerProjectData(root, projectId, process.getuid!(), process.getgid!());
    assert.notEqual(first.root, second.root);
    assert.equal((await lstat(first.workspace)).uid, process.getuid!());
    assert.equal((await resolveDockerProjectData(root, projectId, first.generation))?.root, first.root);
    await rm(second.workspace, { recursive: true });
    await symlink(outside, second.workspace);
    assert.equal(await resolveDockerProjectData(root, projectId, second.generation), undefined);
    assert.equal(await readlink(second.workspace), outside);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
