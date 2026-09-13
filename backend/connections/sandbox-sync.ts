import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SandboxHandle } from '@swarm-hive/sandbox';
import { CONNECTION_ENVS, CONNECTION_ROOT, type ConnectionStore } from './store.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Uses the provider-neutral Sandbox file API for secrets; no credential values enter shell arguments. */
export async function syncSandboxConnections(sandbox: SandboxHandle, store: ConnectionStore, signal: AbortSignal) {
  const bundle = await store.readRuntimeBundle();
  if (!bundle) return {};
  signal.throwIfAborted();
  const staging = `${CONNECTION_ROOT}/generation-${randomUUID()}`;
  const installer = `/tmp/codex-command-tools-${randomUUID()}.sh`;
  const installerContents = await readFile(new URL('../../scripts/sandbox/install-command-tools.sh', import.meta.url), 'utf8');
  const { importedAt: _importedAt, ...content } = bundle;
  const glabHosts = bundle.connections.filter(item => item.type === 'glab').map(item => item.host).filter((host): host is string => Boolean(host));
  const envs = { ...CONNECTION_ENVS, ...(glabHosts.length === 1 ? { GITLAB_HOST: `https://${glabHosts[0]}` } : {}),
    ...(bundle.connections.some(item => item.type === 'kubernetes') ? { KUBECONFIG: `${CONNECTION_ROOT}/current/kubernetes/config.json` } : {}),
    ...(bundle.connections.find(item => item.type === 'meegle')?.host ? { MEEGLE_HOST: bundle.connections.find(item => item.type === 'meegle')!.host! } : {}),
    ...(bundle.connections.some(item => item.type === 'lark') ? {
      LARKSUITE_CLI_CONFIG_DIR: `${CONNECTION_ROOT}/current/lark-config`,
      LARKSUITE_CLI_DATA_DIR: `${CONNECTION_ROOT}/current/lark-data`,
      LARKSUITE_CLI_DEFAULT_AS: 'bot', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    } : {}),
  };
  const version = createHash('sha256').update('connections-v1\n').update(JSON.stringify(content)).update(installerContents).update(JSON.stringify(envs)).digest('hex');
  const cliChecks = Object.keys(bundle.cliFiles ?? {}).map(path => {
    if (!/^(lark-config|lark-data\/lark-cli|meegle|kubernetes)\/[a-zA-Z0-9_.-]+$/.test(path)) throw new Error('凭据路径无效');
    return ' && test -f ' + quote(CONNECTION_ROOT + '/current/' + path);
  }).join('') + (bundle.connections.some(item => item.type === 'meegle') ? ' && test "$(readlink /home/user/.meegle/config.json)" = ' + quote(CONNECTION_ROOT + '/current/meegle/config.json') : '');
  let staged = false;
  // SDK errors may include request headers or command output. Keep an internal,
  // non-sensitive stage instead so the UI can say what needs attention.
  let stage = '检查沙箱命令工具';
  try {
    const probe = await sandbox.commands.run(`if test "$(cat ${quote(`${CONNECTION_ROOT}/current/.version`)} 2>/dev/null)" = ${quote(version)} && test -f ${quote(`${CONNECTION_ROOT}/current/glab/config.yml`)} && test -f ${quote(`${CONNECTION_ROOT}/current/git-credentials`)} && test -f ${quote(`${CONNECTION_ROOT}/current/.mylogin.cnf`)} && test -f /etc/profile.d/codex-connections.sh && command -v mysql >/dev/null && command -v glab >/dev/null && command -v git >/dev/null && command -v lark-cli >/dev/null && command -v meegle >/dev/null && command -v kubectl >/dev/null${cliChecks} && git config --global --get-all include.path | grep -Fxq ${quote(`${CONNECTION_ROOT}/current/gitconfig`)}; then printf ready; fi`, { user: 'user', signal, timeoutMs: 10_000 });
    if (probe.stdout.trim() === 'ready') return envs;
    stage = '安装沙箱命令工具';
    await sandbox.files.write(installer, installerContents, { user: 'root', signal });
    await sandbox.commands.run(`bash ${quote(installer)}`, { user: 'root', signal, timeoutMs: 300_000 });
    stage = '创建凭据目录';
    await sandbox.commands.run(`umask 077; test ! -L ${quote(CONNECTION_ROOT)} && mkdir -p ${quote(CONNECTION_ROOT)} && chmod 700 ${quote(CONNECTION_ROOT)} && mkdir ${quote(staging)} ${quote(`${staging}/glab`)}`, { user: 'user', signal, timeoutMs: 10_000 });
    staged = true;
    stage = '准备凭据文件';
    const cliFiles = Object.entries(bundle.cliFiles ?? {}).map(([path, value]) => {
      if (!/^(lark-config|lark-data\/lark-cli|meegle|kubernetes)\/[a-zA-Z0-9_.-]+$/.test(path)) throw new Error('Invalid credential path');
      return { path, content: new Uint8Array(Buffer.from(value, 'base64')).buffer };
    });
    if (cliFiles.length) await sandbox.commands.run(`mkdir -p ${[...new Set(cliFiles.map(file => `${staging}/${file.path.slice(0, file.path.lastIndexOf('/'))}`))].map(quote).join(' ')}; chmod 700 ${[...new Set(cliFiles.map(file => `${staging}/${file.path.slice(0, file.path.lastIndexOf('/'))}`))].map(quote).join(' ')}`, { user: 'user', signal, timeoutMs: 10_000 });
    const files = [
      { path: 'glab/config.yml', content: bundle.glabConfig },
      { path: 'git-credentials', content: bundle.gitCredentials },
      { path: 'gitconfig', content: bundle.gitConfig },
      { path: '.mylogin.cnf', content: new Uint8Array(Buffer.from(bundle.mysqlLogin ?? '', 'base64')).buffer },
      ...cliFiles,
    ];
    for (const file of files) {
      signal.throwIfAborted();
      await sandbox.files.write(`${staging}/${file.path}`, file.content, { user: 'user', signal });
    }
    stage = '启用凭据文件';
    const include = `${CONNECTION_ROOT}/current/gitconfig`;
    // A generation is complete before switching current. Older copies are removed
    // so deleted/rotated credentials are not left in previous managed generations.
    await sandbox.commands.run(`set -eu; chmod 600 ${files.map(file => quote(`${staging}/${file.path}`)).join(' ')}; chmod 700 ${quote(`${staging}/glab`)}; ln -s ${quote(staging)} ${quote(`${staging}-link`)}; mv -Tf ${quote(`${staging}-link`)} ${quote(`${CONNECTION_ROOT}/current`)}; if ! git config --global --get-all include.path | grep -Fxq ${quote(include)}; then git config --global --add include.path ${quote(include)}; fi; for directory in ${quote(CONNECTION_ROOT)}/generation-*; do if test "$directory" != ${quote(staging)}; then rm -rf -- "$directory"; fi; done`, { user: 'user', signal, timeoutMs: 10_000 });
    if (bundle.connections.some(item => item.type === 'meegle')) {
      stage = '配置 Meegle 凭据';
      // CLI has no config-dir override. Keep its metadata cache in its normal
      // location and link only the managed access-token config, never HOME.
      await sandbox.commands.run(`set -eu; mkdir -p /home/user/.meegle; chmod 700 /home/user/.meegle; target=/home/user/.meegle/config.json; if test -e "$target" && ! test -L "$target"; then echo 'Existing Meegle config requires manual migration' >&2; exit 1; fi; ln -sfn ${quote(`${CONNECTION_ROOT}/current/meegle/config.json`)} "$target"`, { user: 'user', signal, timeoutMs: 10_000 });
    }
    if ('KUBECONFIG' in envs) {
      stage = '配置 Kubernetes 凭据';
      await sandbox.commands.run('mkdir -p /home/user/.kube/cache && chmod 700 /home/user/.kube', { user: 'user', signal, timeoutMs: 10_000 });
    }
    // Login shells launched by the Sandbox and Codex both need the same non-secret paths.
    stage = '配置沙箱环境';
    const profile = `if [ "$HOME" = /home/user ]; then\n${Object.entries(envs).map(([name, value]) => `  export ${name}=${quote(value)}`).join('\n')}\nfi\n`;
    await sandbox.files.write('/etc/profile.d/codex-connections.sh', profile, { user: 'root', signal });
    await sandbox.commands.run('chmod 0644 /etc/profile.d/codex-connections.sh', { user: 'root', signal, timeoutMs: 10_000 });
    await sandbox.commands.run(`umask 077; printf %s ${quote(version)} > ${quote(`${staging}/.version`)}`, { user: 'user', signal, timeoutMs: 10_000 });
    return envs;
  } catch {
    if (signal.aborted) throw new DOMException('任务已停止', 'AbortError');
    // Remote SDK errors can contain request headers; never forward them to UI.
    throw new Error(`${stage}失败，请检查 Docker Sandbox 和命令工具镜像`);
  } finally {
    await sandbox.files.remove(installer, { user: 'root' }).catch(() => {});
    if (staged) await sandbox.commands.run(`if test "$(readlink ${quote(`${CONNECTION_ROOT}/current`)})" != ${quote(staging)}; then rm -rf -- ${quote(staging)} ${quote(`${staging}-link`)}; fi`, { user: 'user', timeoutMs: 10_000 }).catch(() => {});
  }
}
