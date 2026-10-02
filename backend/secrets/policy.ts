import { posix } from 'node:path';
import type { ProjectToolGrant, ProxyTool } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';

export const PROXY_TOOLS: ProxyTool[] = ['mysql', 'kubectl', 'glab', 'lark-cli', 'meegle'];
export function credentialPath(path: string) {
  if (!path || path.length > 256 || path.startsWith('/') || posix.normalize(path) !== path ||
      path.split('/').some(part => !part || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part)) ||
      !/^(?:\.mylogin\.cnf|\.my\.cnf|\.kube\/config|\.config\/(?:glab-cli|lark-cli)\/[^/]+|\.lark-cli\/[^/]+|\.meegle\/[^/]+|\.local\/share\/lark-cli\/[^/]+)$/.test(path))
    throw new HttpError(400, '认证文件路径不受支持');
  return path;
}
export function validateToolArgs(tool: ProxyTool, args: string[], grant: ProjectToolGrant): string[] {
  if (args.length > 32 || args.some(arg => arg.includes('\0')) || args.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 8192)
    throw new HttpError(400, '工具参数超出限制');
  if (tool === 'mysql') {
    if (args.length !== 3 || args[0] !== `--login-path=${grant.alias}` || args[1] !== '-e')
      throw new HttpError(403, '使用 mysql --login-path=连接别名 -e 只读SQL');
    // Comments can split keywords, and executable comments can contain mutations.
    const sql = args[2].trim().replace(/;\s*$/, '');
    if (!/^(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN\s+(?:SELECT|SHOW))\b/i.test(sql) ||
        /;|\/\*|--|#|\b(?:INTO|OUTFILE|DUMPFILE|SLEEP|BENCHMARK|GET_LOCK|RELEASE_LOCK)\b|\bFOR\s+(?:UPDATE|SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(sql))
      throw new HttpError(403, '仅支持单条只读 SQL；数据库账号还必须限制实际库表权限');
    return args;
  }
  if (tool === 'kubectl') return kubectlArgs(args, grant);
  if (!grant.policy.commandPrefixes.some(prefix => prefix.length && prefix.every((arg, i) => args[i] === arg)))
    throw new HttpError(403, '工具操作未获得项目授权');
  // Never allow caller-supplied authentication, arbitrary endpoints, or local files.
  if (args.some(arg => /^(?:--(?:token|access-token|refresh-token|hostname|host|server|config(?:-file|-dir)?|credentials|file|filename|template-file|input)|-f|-F)(?:=|$)/.test(arg) || /(?:^|=)@/.test(arg)))
    throw new HttpError(403, '不能覆盖受保护连接配置');
  const profile = args.indexOf('--profile');
  if ((profile >= 0 && !/^[A-Za-z0-9_-]{1,64}$/.test(args[profile + 1] ?? '')) || args.some(arg => arg.startsWith('--profile=') && !/^[A-Za-z0-9_-]{1,64}$/.test(arg.slice(10))))
    throw new HttpError(403, '配置 profile 名称无效');
  return args;
}
function kubectlArgs(args: string[], grant: ProjectToolGrant): string[] {
  const positions: string[] = []; let namespace = ''; let allNamespaces = false;
  const values = new Set(['--context', '--namespace', '-n', '--output', '-o', '--selector', '-l', '--field-selector', '--request-timeout', '--tail', '--since', '--container', '-c']);
  const switches = new Set(['--all-namespaces', '-A', '--client', '--timestamps', '--previous', '--show-labels', '--no-headers']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positions.push(arg); continue; }
    const equal = arg.indexOf('='), flag = equal < 0 ? arg : arg.slice(0, equal);
    if (values.has(flag)) {
      const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
      if (!value || value.startsWith('-')) throw new HttpError(403, 'kubectl 参数无效');
      if (flag === '--context' && value !== grant.alias) throw new HttpError(403, '连接别名不匹配');
      if (['--namespace', '-n'].includes(flag)) { if (namespace) throw new HttpError(403, 'namespace 不可重复'); namespace = value; }
      if (['-o', '--output'].includes(flag) && !['json', 'yaml', 'wide', 'name'].includes(value)) throw new HttpError(403, '输出格式不受支持');
    } else if (switches.has(flag)) {
      if (equal >= 0 && !['true', 'false'].includes(arg.slice(equal + 1))) throw new HttpError(403, 'kubectl 参数无效');
      if (['-A', '--all-namespaces'].includes(flag) && (equal < 0 || arg.slice(equal + 1) === 'true')) allNamespaces = true;
    } else throw new HttpError(403, 'kubectl 参数未获得授权');
  }
  const [verb, resource] = positions;
  if (!['get', 'describe', 'logs', 'top', 'version', 'api-resources', 'api-versions'].includes(verb)) throw new HttpError(403, '仅允许已授权的 Kubernetes 查询');
  if (['version', 'api-resources', 'api-versions'].includes(verb)) return args;
  const requested = verb === 'logs' ? ['pods/log'] : (resource ?? '').split(',').map(item => item.split('/')[0]);
  if (!requested.length || requested.some(item => !item || !grant.policy.resources.includes(item))) throw new HttpError(403, 'Kubernetes 资源未获得授权');
  if (allNamespaces && !grant.policy.namespaces.includes('*')) throw new HttpError(403, '跨 namespace 查询未获得授权');
  if (namespace && !grant.policy.namespaces.includes('*') && !grant.policy.namespaces.includes(namespace)) throw new HttpError(403, 'namespace 未获得授权');
  if (!namespace && !allNamespaces) {
    if (grant.policy.namespaces.length !== 1 || grant.policy.namespaces[0] === '*') throw new HttpError(403, '请指定授权 namespace');
    return ['--namespace', grant.policy.namespaces[0], ...args];
  }
  return args;
}
