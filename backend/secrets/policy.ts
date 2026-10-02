import { posix } from 'node:path';
import type { ProjectToolGrant, ProxyTool } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';

export { PROXY_TOOLS } from '../../protocol/secret-types.js';
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
    const checked = [...args];
    if (checked[0]?.startsWith('--login-path=')) {
      if (checked.shift() !== `--login-path=${grant.alias}`) throw new HttpError(403, '连接别名不匹配');
    }
    if (checked.length !== 2 || !['-e', '--execute'].includes(checked[0]))
      throw new HttpError(400, '使用 mysql -e SQL 执行所选连接');
    // SQL permissions belong to the selected account. Disable local client
    // commands and local-infile transport in the protected credential process.
    return [`--login-path=${grant.alias}`, '--binary-mode', '--local-infile=0', ...checked];
  }
  if (tool === 'kubectl') {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i], flag = arg.split('=')[0];
      if (flag === '--context') {
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
        if (value !== grant.alias) throw new HttpError(403, '连接别名不匹配');
      }
      if (/^(?:--(?:token|server|kubeconfig|user|cluster|certificate-authority|client-certificate|client-key|tls-server-name|insecure-skip-tls-verify)|-s)(?:=|$)/.test(arg))
        throw new HttpError(403, '不能覆盖受保护连接配置');
    }
    return args;
  }
  // Keep transport/authentication configuration under server control. Command
  // prefixes and resource scopes are deliberately absent from this model.
  if (args.some(arg => /^(?:--(?:token|access-token|refresh-token|hostname|host|server|config(?:-file|-dir)?|credentials|template-file|input))(?:=|$)/.test(arg)))
    throw new HttpError(403, '不能覆盖受保护连接配置');
  const profile = args.indexOf('--profile');
  if ((profile >= 0 && !/^[A-Za-z0-9_-]{1,64}$/.test(args[profile + 1] ?? '')) || args.some(arg => arg.startsWith('--profile=') && !/^[A-Za-z0-9_-]{1,64}$/.test(arg.slice(10))))
    throw new HttpError(403, '配置 profile 名称无效');
  return args;
}
