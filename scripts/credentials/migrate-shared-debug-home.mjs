import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from 'mysql2/promise';

const nativePrefix = 'native:v1:';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
class MigrationError extends Error {}

function relativeCredentialPath(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || isAbsolute(value) ||
      normalize(value) !== value || /[\\\u0000-\u001f\u007f]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe registered credential path');
  }
  return value;
}

function registrationFiles(registration) {
  if (!uuid.test(registration.id) || !registration.tool || !registration.path ||
      ['mysql', 'kubectl'].includes(registration.tool) ||
      typeof registration.ciphertext !== 'string' || !registration.ciphertext.startsWith(nativePrefix)) {
    throw new Error('Invalid generic native credential registration');
  }
  let descriptor;
  try { descriptor = JSON.parse(registration.ciphertext.slice(nativePrefix.length)); }
  catch { throw new Error('Invalid native credential metadata'); }
  if (!descriptor || descriptor.kind !== registration.format || !Array.isArray(descriptor.files) || descriptor.files.length > 128) throw new Error('Invalid native credential metadata');
  const registeredPath = relativeCredentialPath(registration.path);
  if (!descriptor.files.length) throw new Error('Empty native HOME registration is not a file migration');
  if (descriptor.files[0]?.path !== registeredPath) throw new Error('Native credential path does not match registration');
  const files = descriptor.files.map(file => relativeCredentialPath(file?.path));
  if (new Set(files).size !== files.length) throw new Error('Duplicate registered credential path');
  // UUID first-level directories are reserved for native per-secret sources.
  if (files.some(file => uuid.test(file.split('/')[0]))) throw new Error('Credential path collides with a reserved native source directory');
  return files;
}

function contained(root, path) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Credential path escapes shared HOME');
  return path;
}

async function assertDirectoryChain(root, path, { allowMissing = false } = {}) {
  contained(root, path);
  let current = parse(root).root;
  const allParts = [...root.slice(current.length).split(sep).filter(Boolean), ...relative(root, path).split(sep).filter(Boolean)];
  for (const [index, part] of allParts.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
    } catch (error) {
      if (error?.code === 'ENOENT' && allowMissing && index >= root.slice(parse(root).root.length).split(sep).filter(Boolean).length) return false;
      throw error;
    }
  }
  return true;
}

async function inspectFile(root, path, { allowMissing = false } = {}) {
  await assertDirectoryChain(root, dirname(path), { allowMissing });
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe credential file');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.size > 2 * 1024 * 1024) throw new Error('Invalid credential file');
      return await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) return null;
    throw error;
  }
}

async function ensureDirectories(root, path) {
  contained(root, path);
  const rel = relative(root, path);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
  }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Moves registered generic native files without exposing credential contents. */
export async function migrateSharedDebugHome(rootInput, registrations, { apply = false } = {}) {
  const root = resolve(rootInput);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Unsafe shared HOME root');

  const moves = [];
  const targets = new Set();
  for (const registration of registrations) {
    for (const file of registrationFiles(registration)) {
      const source = contained(root, join(root, registration.id, file));
      const target = contained(root, join(root, file));
      if ([...targets].some(other => other === target || other.startsWith(target + sep) || target.startsWith(other + sep)))
        throw new MigrationError(`Conflicting shared HOME paths: ${target}`);
      targets.add(target);
      moves.push({ id: registration.id, relativePath: file, source, target });
    }
  }

  // Complete every source/target check before moving any file.
  for (const move of moves) {
    const [sourceBytes, targetBytes] = await Promise.all([
      inspectFile(root, move.source, { allowMissing: true }),
      inspectFile(root, move.target, { allowMissing: true }),
    ]);
    if (!sourceBytes && !targetBytes) throw new MigrationError(`Registered credential file is missing: ${move.source}`);
    if (sourceBytes && targetBytes && !sourceBytes.equals(targetBytes)) throw new MigrationError(`Shared HOME target differs from source: ${move.target}`);
    move.status = sourceBytes ? (targetBytes ? 'same' : 'move') : 'already-migrated';
  }

  if (apply) {
    for (const move of moves) {
      if (move.status === 'same') {
        await unlink(move.source);
        await syncDirectory(dirname(move.source));
        continue;
      }
      if (move.status !== 'move') continue;
      await ensureDirectories(root, dirname(move.target));
      // link() creates the target exclusively. It cannot replace a CLI-refreshed
      // file that appeared after preflight; unlink then completes the move.
      await link(move.source, move.target);
      await syncDirectory(dirname(move.target));
      await unlink(move.source);
      await syncDirectory(dirname(move.source));
      move.status = 'moved';
    }
  }

  return {
    dryRun: !apply,
    credentialCount: registrations.length,
    fileCount: moves.length,
    pending: moves.filter(move => move.status === 'move').length,
    moved: moves.filter(move => move.status === 'moved').length,
    alreadyMigrated: moves.filter(move => move.status === 'already-migrated').length,
    unchangedTarget: moves.filter(move => move.status === 'same').length,
    files: moves.map(({ relativePath, source, target, status }) => ({ relativePath, source, target, status })),
  };
}

async function main() {
  const usage = 'Usage: node scripts/credentials/migrate-shared-debug-home.mjs [--apply]\nDefault: read-only preflight. Stop CoCell and CLI writers before --apply. No database changes.';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  if (args.some(arg => arg !== '--apply') || args.length > 1) throw new MigrationError(usage);
  try { loadEnvFile(); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (!process.env.MYSQL_URL) throw new Error('MYSQL_URL is required');

  let shared = false;
  if (process.env.COCELL_MOUNTS_CONFIG) {
    const config = JSON.parse(await (await import('node:fs/promises')).readFile(process.env.COCELL_MOUNTS_CONFIG, 'utf8'));
    const directory = config?.sharedDirectory;
    if (!directory || typeof directory.enabled !== 'boolean' || typeof directory.hostPath !== 'string' || typeof directory.nodeName !== 'string') {
      throw new Error('Invalid shared mount configuration');
    }
    if (directory.enabled && (!directory.hostPath.startsWith('/') || directory.hostPath === '/' || !directory.nodeName.trim())) {
      throw new Error('Invalid shared mount configuration');
    }
    shared = directory.enabled;
  }
  const sharedDataRoot = resolve(shared ? '/app/shared' : (process.env.SHARED_DATA_DIRECTORY || 'data'));
  const root = join(sharedDataRoot, 'runtime/debug-homes');
  const pool = createPool({ uri: process.env.MYSQL_URL, connectionLimit: 2 });
  try {
    // ciphertext is selected only to parse the native:v1 file-path descriptor;
    // that descriptor contains paths, not credential bytes, and is never logged.
    const [rows] = await pool.query(
      "SELECT s.id, s.format, s.ciphertext, c.tool, c.path FROM secrets s JOIN secret_tool_configs c ON c.secret_id=s.id WHERE s.ciphertext LIKE 'native:v1:%' AND s.format<>'home' AND c.tool NOT IN ('mysql','kubectl') AND c.tool<>'' AND c.path<>'' ORDER BY s.id",
    );
    const result = await migrateSharedDebugHome(root, rows, { apply: args.includes('--apply') });
    console.log(JSON.stringify({ directory: root, ...result }));
  } finally { await pool.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const detail = error instanceof MigrationError ? error.message : typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'Check registration metadata, file paths, and permissions.';
    console.error(`Shared debug HOME migration failed: ${detail}`);
    process.exitCode = 1;
  });
}
