import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openMeegleBundle, rebindMeegleBundle, validateFileBundle } from './credential-files.mjs';

function fingerprint(bundle) {
  // Re-encryption alone must not consume a central version. Compare the native
  // token data while persisting only a digest, never decrypted credentials.
  const content = bundle.adapter === 'meegle'
    ? { files: bundle.files.map(file => ({ path: file.path, ...(file.path === '.meegle/config.json' ? { content: file.content } : {}) })),
      tokens: Object.fromEntries(Object.entries(openMeegleBundle(bundle)).sort(([a], [b]) => a.localeCompare(b))) }
    : bundle;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

async function atomicFile(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function lockState(state) {
  const lock = join(state, 'lock'), start = Date.now();
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 }); return () => rm(lock, { recursive: true, force: true }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    try {
      const pid = Number(await readFile(join(lock, 'pid'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid credential lock');
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') { await rm(lock, { recursive: true, force: true }); continue; } throw error; }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Recover a process that died between mkdir and recording its owner.
      try { if (Date.now() - (await lstat(lock)).mtimeMs > 30000) { await rm(lock, { recursive: true, force: true }); continue; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (Date.now() - start > 4000) throw new Error('Credential files are busy; try again after the current tool finishes');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
export async function runBundleTool(tool, args, config, options, request) {
  const resource = config.files.filter(file => file.tool === tool)[0];
  if (!resource || config.files.filter(file => file.tool === tool).length !== 1) throw new Error('Select one file group per tool');
  const source = validateFileBundle(JSON.parse(Buffer.from(resource.content, 'base64').toString('utf8')));
  if (source.files[0].path !== resource.path || (source.adapter === 'meegle' && tool !== 'meegle')) throw new Error('Invalid file group binding');
  const snapshot = createHash('sha256').update(JSON.stringify({ generation: config.generation, resource })).digest('hex');
  const state = join(options.tempRoot ?? '/var/lib/cellbox/debug/tool-homes', tool, snapshot), root = join(state, 'home');
  await mkdir(state, { recursive: true, mode: 0o700 }); await chmod(state, 0o700);
  const unlock = await lockState(state);
  try {
    const syncedPath = join(state, 'synced.json'), materialPath = join(state, 'material.json'), pendingPath = join(state, 'pending.json');
    const masks = [config.token];
    function mask(bundle) {
      for (const file of bundle.files) masks.push(...options.sensitiveValues(Buffer.from(file.content)));
      if (bundle.adapter === 'meegle') masks.push(...options.sensitiveValues(Buffer.from(JSON.stringify(openMeegleBundle(bundle)))));
    }
    mask(source);
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, '.local/share') };
    const identity = { hostname: hostname(), username: 'unknown' };
    // USER is explicit so the native CLI uses the same identity as the adapter.
    if (source.adapter === 'meegle') env.USER = identity.username;
    async function install(bundle) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      for (const file of bundle.files) {
        let parent = root;
        for (const part of file.path.split('/').slice(0, -1)) {
          parent = join(parent, part); await mkdir(parent, { recursive: true, mode: 0o700 });
          const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
        }
        await atomicFile(join(root, file.path), file.content);
      }
      await atomicFile(materialPath, JSON.stringify(bundle));
      await rm(pendingPath, { force: true });
    }
    let material;
    try { material = validateFileBundle(JSON.parse(await readFile(pendingPath, 'utf8'))); mask(material); await install(material); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { material = validateFileBundle(JSON.parse(await readFile(materialPath, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    async function collect() {
      return validateFileBundle({ ...material, files: await Promise.all(material.files.map(async file => {
        const bytes = await options.readCredential(root, file.path), content = bytes.toString('utf8');
        if (!Buffer.from(content).equals(bytes)) throw new Error('Credential file is not UTF-8');
        return { path: file.path, content };
      })) });
    }
    if (!material || (material.adapter === 'meegle' && (material.identity.hostname !== identity.hostname || material.identity.username !== identity.username))) {
      const current = material ? await collect() : source;
      mask(current);
      material = current.adapter === 'meegle' ? rebindMeegleBundle(current, identity) : current;
      // Journal the whole destination group before changing any native file.
      await atomicFile(pendingPath, JSON.stringify(material)); await install(material);
    }
    let synced;
    try { synced = JSON.parse(await readFile(syncedPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      synced = { digest: fingerprint(source), version: resource.version };
      await atomicFile(syncedPath, JSON.stringify(synced));
    }
    mask(await collect());
    const credential = join(root, resource.path);
    if (tool === 'kubectl') env.KUBECONFIG = credential;
    if (tool === 'glab') env.GLAB_CONFIG_DIR = dirname(credential);
    if (tool === 'mysql') args = [`--defaults-file=${credential}`, ...args];
    const result = await options.execute(join(options.binaryRoot ?? '/opt/cellbox/debug-bin', tool), args, env, root);
    const current = await collect(); mask(current);
    const content = JSON.stringify(current), digest = fingerprint(current);
    if (resource.mutable && digest !== synced.digest) {
      try {
        const response = await request('/api/tool-runtime/files', { tool, updates: [{ secretId: resource.secretId, content: Buffer.from(content).toString('base64'), baseVersion: synced.version, format: 'files' }], exitCode: result.exitCode });
        const savedVersion = response.versions?.find(version => version.secretId === resource.secretId)?.version;
        if (response.saved && savedVersion !== synced.version + 1) throw new Error('File group save was not acknowledged');
        await atomicFile(syncedPath, JSON.stringify({ digest, version: savedVersion ?? synced.version }));
      } catch {
        (options.stderr ?? process.stderr).write('File group update failed or conflicted; local files retained. Refresh the environment to load the saved version.\n');
      }
    }
    const redact = text => masks.sort((a, b) => b.length - a.length).reduce((value, secret) => secret ? value.replaceAll(secret, '[REDACTED]') : value, text);
    (options.stdout ?? process.stdout).write(redact(result.stdout));
    (options.stderr ?? process.stderr).write(redact(result.stderr));
    return result.exitCode;
  } finally { await unlock(); }
}
