import type { ToolCatalogEntry, ToolPermission } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import type { CredentialSource, Tool, ToolWithCredential } from './interfaces.js';
import { BasicTool } from './implementations/tool.js';
import { MysqlTool } from './implementations/mysql.js';
import { KubectlTool } from './implementations/kubectl.js';

export type { Tool, ToolWithCredential, CredentialCatalog, CredentialSource } from './interfaces.js';
const implementations: Tool[] = [new MysqlTool(), new KubectlTool(),
  ...['git', 'glab', 'meegle', 'lark-cli'].map(name => new BasicTool(name))];
const tools = new Map(implementations.map(tool => [tool.name, tool]));

export function getTool(name: string): Tool { return tools.get(name) ?? new BasicTool(name); }
export function hasCredentials(tool: Tool): tool is ToolWithCredential { return tool.kind === 'tool-with-credential'; }
export function credentialTool(name: string) { const tool = getTool(name); return hasCredentials(tool) ? tool : undefined; }
export function registeredTools() { return [...tools.values()]; }
export function describeTool(tool: Tool, sources: readonly CredentialSource[], mountedConfig?: Buffer): ToolCatalogEntry {
  if (!hasCredentials(tool)) return { name: tool.name, kind: 'tool' };
  const catalog = tool.listCredentials(sources, mountedConfig);
  return { name: tool.name, kind: tool.kind, credentials: [...catalog.names],
    ...(catalog.defaultName ? { defaultCredential: catalog.defaultName } : {}) };
}

/** Runtime authorization checks grants, never credential existence or validity. */
export function authorizeCredential(tool: ToolWithCredential, permission: ToolPermission, args: readonly string[]) {
  const name = tool.resolveCredential(args);
  if (name === undefined) return [...args];
  if (!Array.isArray(permission.credentials) || !permission.credentials.includes(name)) throw new HttpError(403, `项目未授权 ${tool.name} 凭据：${name}`);
  // Pass the explicitly authorized name to the native CLI unchanged in meaning.
  const checked: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === tool.credentialOption) { i++; continue; }
    if (!args[i].startsWith(tool.credentialOption + '=')) checked.push(args[i]);
  }
  const result = [`${tool.credentialOption}=${name}`, ...checked];
  if (result.length > 32 || result.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 8192)
    throw new HttpError(400, '工具参数超出限制');
  return result;
}
