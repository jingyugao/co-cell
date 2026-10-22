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
  definition('git', '.gitconfig', ['.gitconfig', '.git-credentials'], { GIT_CONFIG_GLOBAL: '${CREDENTIAL}' }),
  definition('glab', '.config/glab-cli/config.yml', ['.config/glab-cli']),
  definition('kubectl', '.kube/config', ['.kube/config'], { KUBECONFIG: '${CREDENTIAL}' }, { permission: kubePermission }),
  definition('meegle', '.meegle/config.json', ['.meegle'], { USER: TOOL_CREDENTIAL_IDENTITY.username }, { load: meegleLoad, save: meegleSave }),
  definition('lark-cli', '.lark-cli/config.json', ['.lark-cli/config.json', '.local/share/lark-cli'], {}, { load: larkLoad, save: larkSave }),
];
