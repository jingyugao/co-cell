import type { DynamicToolInput } from '../../protocol/tool-types.js';
import type { ToolScript } from '../../protocol/tool-script-types.js';
import { meegleLoadHook, meegleSaveHook, larkLoadHook, larkSaveHook } from './encrypted-hook-defaults.js';
import { TOOL_CREDENTIAL_IDENTITY } from '../../util/tool-runtime-identity.mjs';

type DefaultScript = Omit<ToolScript, 'version' | 'createdAt' | 'updatedAt'>;
const script = (suffix: string, name: string, language: ToolScript['language'], source: string): DefaultScript => ({
  id: `a3ecfbe4-782a-4db0-85cc-12f5b4a4d${suffix}`, name, language, source,
});
const kubePermission = script('305', 'Kubernetes context permission', 'typescript', `const selected = input.args.find(arg => arg.startsWith('--context='))?.slice(10);
return { allow: selected === undefined || (input.permission.credentials ?? []).includes(selected), reason: '项目未授权此 Kubernetes context' };`);
const meegleLoad = script('306', 'Meegle load hook', 'bash', meegleLoadHook);
const meegleSave = script('307', 'Meegle save hook', 'bash', meegleSaveHook);
const larkLoad = script('308', 'Lark load hook', 'bash', larkLoadHook);
const larkSave = script('309', 'Lark save hook', 'bash', larkSaveHook);

export const additionalToolScriptDefaults = [kubePermission, meegleLoad, meegleSave, larkLoad, larkSave];
const definition = (name: string, path: string, roots: string[], env: Record<string, string> = {},
  scripts: { load?: DefaultScript; save?: DefaultScript; permission?: DefaultScript } = {}): DynamicToolInput => ({
  name, description: '', instructions: '', enabled: true, executable: `/opt/cellbox/debug-bin/${name}`,
  args: [], env, credentialPath: path, credentialPaths: roots, timeoutMs: 20000,
  ...(scripts.load ? { credentialParseScriptId: scripts.load.id } : {}),
  ...(scripts.save ? { credentialSaveScriptId: scripts.save.id } : {}),
  ...(scripts.permission ? { permissionScriptId: scripts.permission.id } : {}),
});
export const additionalToolDefaults = [
  {
    ...definition('ssh', '.ssh/config', ['.ssh']),
    executable: '/usr/bin/ssh',
    description: 'SSH 原生 Host 别名与多私钥连接',
    instructions: 'ssh <Host别名> [远程命令]；使用项目角色授权的 .ssh/config Host 别名。每个 Host 可配置不同的 HostName、User、Port 和 IdentityFile。IdentityFile 使用 /home/debug/.ssh/ 下的绝对路径；不要使用 ~ 或相对路径。凭据目录为 /home/debug/.ssh，私钥权限为 0600。预先在 known_hosts 中添加可信主机密钥。仅支持非交互式密钥认证；连接选项在配置文件中设置。可使用 -v、-vv、-vvv、-q、-T、-n、-G，以及 ssh -V。',
  },
  definition('git', '.gitconfig', ['.gitconfig', '.git-credentials'], { GIT_CONFIG_GLOBAL: '${CREDENTIAL}' }),
  definition('glab', '.config/glab-cli/config.yml', ['.config/glab-cli']),
  definition('kubectl', '.kube/config', ['.kube/config'], { KUBECONFIG: '${CREDENTIAL}' }, { permission: kubePermission }),
  definition('meegle', '.meegle/config.json', ['.meegle'], { USER: TOOL_CREDENTIAL_IDENTITY.username }, { load: meegleLoad, save: meegleSave }),
  definition('lark-cli', '.lark-cli/config.json', ['.lark-cli/config.json', '.local/share/lark-cli'], {}, { load: larkLoad, save: larkSave }),
];
