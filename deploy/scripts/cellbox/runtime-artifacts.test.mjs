import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateArtifacts } from './runtime-artifacts.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sha512Integrity = value => `sha512-${createHash('sha512').update(value).digest('base64')}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cocell-runtime-artifacts-'));
  const contents = new Map([
    ['codex.tgz', Buffer.from('synthetic codex package')],
    ['codex-linux-x64.tgz', Buffer.from('synthetic native codex package')],
    ['restic', Buffer.from('synthetic restic binary')],
  ]);
  const packages = {
    codexVersion: '1.2.3',
    codex: { file: 'codex.tgz', url: 'https://packages.example.test/codex.tgz', integrity: sha512Integrity(contents.get('codex.tgz')) },
    codexLinuxX64: { file: 'codex-linux-x64.tgz', url: 'https://packages.example.test/codex-linux-x64.tgz', integrity: sha512Integrity(contents.get('codex-linux-x64.tgz')) },
    resticVersion: '0.18.1',
    restic: { file: 'restic', url: 'https://packages.example.test/restic.bz2', sha256: sha256(contents.get('restic')) },
    systemPackages: ['ca-certificates'],
  };
  const baseImageId = `sha256:${'a'.repeat(64)}`;
  try {
    for (const [path, bytes] of contents) await writeFile(join(root, path), bytes);
    const manifest = {
      baseImage: 'node:22.18.0-bookworm-slim', baseImageId, packages,
      files: [...contents].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
    };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    return { root, contents, packages, baseImageId, manifest };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('accepts a complete offline runtime artifact bundle with matching package lock and base image identity', async () => {
  const value = await fixture();
  try {
    const manifest = await validateArtifacts(value.root, { baseImageId: value.baseImageId, packages: value.packages });
    assert.equal(manifest.baseImage, 'node:22.18.0-bookworm-slim');
    assert.equal(manifest.files.length, 3);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('rejects a runtime package version or lock mismatch', async () => {
  const value = await fixture();
  try {
    const changed = structuredClone(value.packages);
    changed.codexVersion = '1.2.4';
    await assert.rejects(validateArtifacts(value.root, { packages: changed }), /package versions changed/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('rejects artifacts prepared for a different immutable base image', async () => {
  const value = await fixture();
  try {
    await assert.rejects(validateArtifacts(value.root, {
      packages: value.packages, baseImageId: `sha256:${'b'.repeat(64)}`,
    }), /base image differs/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('rejects corrupted payloads even when their manifest checksum is unchanged', async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.root, 'codex-linux-x64.tgz'), 'corrupted native package');
    await assert.rejects(validateArtifacts(value.root, { packages: value.packages }), /checksum mismatch: codex-linux-x64\.tgz/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('rejects a manifest that omits any required codex, native codex, or restic payload', async () => {
  const required = ['codex.tgz', 'codex-linux-x64.tgz', 'restic'];
  for (const missing of required) {
    const value = await fixture();
    try {
      value.manifest.files = value.manifest.files.filter(file => file.path !== missing);
      await writeFile(join(value.root, 'manifest.json'), JSON.stringify(value.manifest));
      await assert.rejects(validateArtifacts(value.root, { packages: value.packages }), /Required artifact missing/);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test('rejects unsafe or duplicate file entries and unlisted Debian package payloads', async () => {
  const value = await fixture();
  try {
    const first = { ...value.manifest.files[0] };
    value.manifest.files.push({ ...first });
    await writeFile(join(value.root, 'manifest.json'), JSON.stringify(value.manifest));
    await assert.rejects(validateArtifacts(value.root, { packages: value.packages }), /Invalid or duplicate/);

    value.manifest.files.pop();
    value.manifest.files[0].path = '../outside';
    await writeFile(join(value.root, 'manifest.json'), JSON.stringify(value.manifest));
    await assert.rejects(validateArtifacts(value.root, { packages: value.packages }), /Invalid or duplicate/);

    value.manifest.files[0] = first;
    await mkdir(join(value.root, 'debs'));
    await writeFile(join(value.root, 'debs', 'unlisted.deb'), 'synthetic deb');
    await writeFile(join(value.root, 'manifest.json'), JSON.stringify(value.manifest));
    await assert.rejects(validateArtifacts(value.root, { packages: value.packages }), /Unverified system artifact/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('accepts a listed and checksum-verified Debian package with epoch and tilde in its version', async () => {
  const value = await fixture();
  try {
    const path = 'debs/libssl3_3.0.17-1~deb12u2_amd64.deb';
    const payload = Buffer.from('synthetic verified Debian package');
    await mkdir(join(value.root, 'debs'));
    await writeFile(join(value.root, path), payload);
    value.manifest.files.push({ path, sha256: sha256(payload) });
    await writeFile(join(value.root, 'manifest.json'), JSON.stringify(value.manifest));

    const manifest = await validateArtifacts(value.root, { packages: value.packages });
    assert.ok(manifest.files.some(file => file.path === path));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
