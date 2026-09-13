import { chmod, chown, mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import type { ConnectionStore } from './store.js';

/** Materialize only CLI-consumable credentials for the Sandbox's read-only mount. */
export async function syncSandboxConnections(store: ConnectionStore) {
  const bundle = await store.readRuntimeBundle();
  if (!bundle) return {};
  const root = store.sandboxRuntimeDirectory();
  const generationName = `generation-${randomUUID()}`;
  const staging = join(root, generationName);
  const current = join(root, 'current');
  const { importedAt: _importedAt, ...content } = bundle;
  const glabHosts = bundle.connections.filter(item => item.type === 'glab').map(item => item.host).filter((host): host is string => Boolean(host));
  const envs = {
    GLAB_CONFIG_DIR: '/home/user/.codex-web/credentials/current/glab',
    MYSQL_TEST_LOGIN_FILE: '/home/user/.codex-web/credentials/current/.mylogin.cnf',
    GIT_TERMINAL_PROMPT: '0',
    ...(glabHosts.length === 1 ? { GITLAB_HOST: `https://${glabHosts[0]}` } : {}),
    ...(bundle.connections.some(item => item.type === 'kubernetes') ? { KUBECONFIG: '/home/user/.codex-web/credentials/current/kubernetes/config.json' } : {}),
    ...(bundle.connections.find(item => item.type === 'meegle')?.host ? { MEEGLE_HOST: bundle.connections.find(item => item.type === 'meegle')!.host! } : {}),
    ...(bundle.connections.some(item => item.type === 'lark') ? {
      LARKSUITE_CLI_CONFIG_DIR: '/home/user/.codex-web/credentials/current/lark-config',
      LARKSUITE_CLI_DATA_DIR: '/home/user/.codex-web/credentials/current/lark-data',
      LARKSUITE_CLI_DEFAULT_AS: 'bot', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    } : {}),
  };
  const cliFiles = Object.entries(bundle.cliFiles ?? {}).map(([path, value]) => {
    if (!/^(lark-config|lark-data\/lark-cli|meegle|kubernetes)\/[a-zA-Z0-9_.-]+$/.test(path)) throw new Error('凭据路径无效');
    return { path, content: Buffer.from(value, 'base64') };
  });
  const files = [
    { path: 'glab/config.yml', content: Buffer.from(bundle.glabConfig) },
    { path: 'git-credentials', content: Buffer.from(bundle.gitCredentials) },
    { path: 'gitconfig', content: Buffer.from(bundle.gitConfig) },
    { path: '.mylogin.cnf', content: Buffer.from(bundle.mysqlLogin ?? '', 'base64') },
    ...cliFiles,
  ];
  const version = createHash('sha256').update('sandbox-credentials-v2\n').update(JSON.stringify(content)).update(JSON.stringify(envs)).digest('hex');
  // This directory alone is bind-mounted. Its contents remain per-file private
  // to the Sandbox's fixed UID, while the persistent credential bundle stays
  // in its non-mounted parent directory.
  await mkdir(root, { recursive: true, mode: 0o755 });
  await chmod(root, 0o755);
  await mkdir(join(staging, 'glab'), { recursive: true, mode: 0o700 });
  await chown(staging, 1000, 1000);
  await chown(join(staging, 'glab'), 1000, 1000);
  try {
    for (const file of files) {
      const destination = join(staging, file.path);
      const parent = dirname(destination);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const segments = file.path.split('/').slice(0, -1);
      for (let index = 1; index <= segments.length; index += 1) await chown(join(staging, ...segments.slice(0, index)), 1000, 1000);
      await writeFile(destination, file.content, { mode: 0o600, flag: 'wx' });
      await chown(destination, 1000, 1000);
    }
    await writeFile(join(staging, '.version'), version, { mode: 0o600, flag: 'wx' });
    await chown(join(staging, '.version'), 1000, 1000);
    const next = join(root, `${generationName}-link`);
    await symlink(generationName, next);
    await rename(next, current);
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(entries.filter(entry => entry.name.startsWith('generation-') && entry.name !== generationName && entry.name !== `${generationName}-link`)
      .map(entry => rm(join(root, entry.name), { recursive: true, force: true })));
    return envs;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
