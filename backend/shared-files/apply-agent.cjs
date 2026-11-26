// Runs as the project agent. File contents are never executed during installation.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const [assets, workspace, home] = process.argv.slice(1);
const product = path.join(workspace, '.cocell');
const revision = path.basename(path.dirname(assets));
if (!/^[a-f0-9]{64}$/.test(revision) || !fs.statSync(assets).isDirectory()) throw Error('Invalid Agent assets');
function linkTo(dest, source, replaceDirectory = false) {
  const existing = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() && fs.readlinkSync(dest) === source) return;
  if (existing?.isDirectory() && replaceDirectory) fs.rmSync(dest, { recursive: true });
  const tmp = dest + '.agent-' + randomUUID();
  try {
    fs.symlinkSync(source, tmp);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
const codex = path.join(product, 'codex'),
  claude = path.join(product, 'claude');
for (const dest of [codex, claude]) fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
for (const [dest, name] of [
  [codex, 'AGENTS.md'],
  [claude, 'CLAUDE.md'],
]) {
  linkTo(path.join(dest, name), path.join(assets, 'AGENTS.md'));
  linkTo(path.join(dest, 'docs'), path.join(assets, 'docs'), true);
}
linkTo(path.join(product, 'agent-assets'), assets);
const skillRoot = path.join(assets, 'skills');
const names = new Set(fs.readdirSync(skillRoot));
const managedRoots = [
  '/var/lib/cellbox/shared/harness/versions',
  '/var/lib/cellbox/shared/agents/versions',
  path.join(product, 'agent-versions'),
];
for (const dest of [path.join(home, '.agents/skills'), path.join(codex, 'skills'), path.join(claude, 'skills')]) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const file = path.join(dest, entry.name),
      target = fs.readlinkSync(file);
    const owned = managedRoots.some((root) => {
      const parts = path.relative(root, target).split('/');
      return (
        parts.length === 4 &&
        /^[0-9a-f]{64}$/.test(parts[0]) &&
        parts[1] === 'assets' &&
        parts[2] === 'skills' &&
        parts[3] === entry.name
      );
    });
    if (owned && !names.has(entry.name)) fs.unlinkSync(file);
    if (owned && names.has(entry.name)) linkTo(file, path.join(skillRoot, entry.name));
  }
  for (const name of names) {
    const file = path.join(dest, name);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) linkTo(file, path.join(skillRoot, name));
  }
}
