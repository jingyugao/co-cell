import type { ProxyTool, SecretFormat } from '../protocol/secret-types.js';

export const TOOL_LABELS: Record<ProxyTool, string> = {
  mysql: 'MySQL', kubectl: 'Kubernetes', glab: 'GitLab', 'lark-cli': '飞书', meegle: 'Meegle',
};
export function defaultCredentialPath(tool: ProxyTool, format: SecretFormat): string {
  if (tool === 'mysql') return format === 'binary' ? '.mylogin.cnf' : '.my.cnf';
  return { kubectl: '.kube/config', glab: '.config/glab-cli/config.yml',
    'lark-cli': '.lark-cli/config.json', meegle: '.meegle/credentials.json' }[tool];
}
