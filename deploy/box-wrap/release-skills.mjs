// Install only release-owned links. Personal skills in the same directories survive upgrades.
import { mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function attachReleaseSkills(assets, home, workspace = '/home/agent/workspace') {
  const source = join(assets, 'skills');
  const published = await readdir(source, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const names = new Set(published.filter(entry => entry.isDirectory()).map(entry => entry.name));
  const versions = dirname(dirname(assets));
  for (const dest of [join(home, '.agents/skills'), join(workspace, '.cocell/codex/skills'), join(workspace, '.cocell/claude/skills')]) {
    if (names.size) await mkdir(dest, { recursive: true, mode: 0o700 });
    const entries = await readdir(dest, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const owned = new Set();
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const file = join(dest, entry.name);
      const target = await readlink(file);
      const parts = relative(versions, target).split('/');
      if (parts.length !== 4 || !/^[a-f0-9]{64}$/.test(parts[0]) ||
          parts[1] !== 'assets' || parts[2] !== 'skills' || basename(target) !== entry.name) continue;
      owned.add(entry.name);
      if (!names.has(entry.name)) await rm(file);
    }
    const existing = new Set(entries.map(entry => entry.name));
    for (const name of names) {
      if (existing.has(name) && !owned.has(name)) continue;
      const target = join(source, name), file = join(dest, name);
      if (owned.has(name) && await readlink(file) === target) continue;
      if (!owned.has(name)) { await symlink(target, file); continue; }
      const temporary = join(dest, '.release-' + randomUUID());
      try { await symlink(target, temporary); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
    }
  }
}
