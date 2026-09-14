import { chmod, chown, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import type { ConnectionStore } from './store.js';

/** Materialize CLI credentials in the stable host directory mounted by Sandboxes. */
export async function syncSandboxConnections(store: ConnectionStore) {
  const bundle = await store.readRuntimeBundle();
  if (!bundle) return {};
  const root = store.sandboxDirectory();
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
  // Bundles imported before the default-host support stored JSON/YAML without
  // `host`. Upgrade that generated format while preserving multi-host files.
  let glabConfig = bundle.glabConfig;
  if (glabHosts.length === 1) {
    try {
      const parsed = JSON.parse(glabConfig);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.host) {
        glabConfig = JSON.stringify({ ...parsed, host: glabHosts[0] }, null, 2);
      }
    } catch { /* A manually supplied YAML config remains untouched. */ }
  }
  const files = [
    { path: 'glab/config.yml', content: Buffer.from(glabConfig) },
    { path: 'git-credentials', content: Buffer.from(bundle.gitCredentials) },
    { path: 'gitconfig', content: Buffer.from(bundle.gitConfig) },
    { path: '.mylogin.cnf', content: Buffer.from(bundle.mysqlLogin ?? '', 'base64') },
    ...cliFiles,
  ];
  const version = createHash('sha256').update('sandbox-credentials-v3\n').update(JSON.stringify(content)).update(JSON.stringify(envs))
    .update(glabConfig).digest('hex');
  // Never replace this directory: a Docker bind mount follows its inode.
  // Instead replace individual files only when an imported bundle changes.
  // Hand edits therefore remain visible to already-running Sandboxes.
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chown(root, 1000, 1000);
  const previous = await readFile(join(root, '.version'), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  if (previous.trim() === version) return envs;
  for (const file of files) {
    const destination = join(root, file.path);
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chown(parent, 1000, 1000);
    const temporary = join(parent, `.${file.path.split('/').at(-1)}-${randomUUID()}.tmp`);
    await writeFile(temporary, file.content, { mode: 0o600, flag: 'wx' });
    await chown(temporary, 1000, 1000);
    await rename(temporary, destination);
  }
  const versionFile = join(root, `.version-${randomUUID()}.tmp`);
  await writeFile(versionFile, version, { mode: 0o600, flag: 'wx' });
  await chown(versionFile, 1000, 1000);
  await rename(versionFile, join(root, '.version'));
  return envs;
}
