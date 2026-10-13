import { randomUUID } from 'node:crypto';
import type { ProjectRoleState, ProjectToolGrant, ToolRoleInput } from '../../protocol/secret-types.js';
import type { SecretRepository } from './repository.js';
import { HttpError } from '../../util/errors.js';
import { credentialPath, toolName } from './policy.js';

export const CONNECTION_ALIAS = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const namedConnectionTool = (tool: string) => tool === 'mysql' || tool === 'kubectl';
export function connectionPath(grant: ProjectToolGrant) {
  return namedConnectionTool(grant.tool)
    ? `.cocell/connections/${grant.tool}/${grant.files[0].secretId}/config`
    : grant.files[0].path;
}

/** Roles select credentials; database grants and cluster RBAC enforce resource permissions. */
export class ToolRoles {
  constructor(private repository: SecretRepository, private refresh: (projectIds: string[]) => Promise<void>) {}
  catalog() { return this.repository.roles.catalog(); }
  async save(input: ToolRoleInput, id?: string) {
    const catalog = await this.catalog();
    const previous = id ? catalog.roles.find(role => role.id === id) : undefined;
    if (id && !previous) throw new HttpError(404, '角色不存在');
    const name = input.name.trim();
    if (!name || name.length > 100 || input.connections.length > 256) throw new HttpError(400, '角色名称或连接数量无效');
    if (catalog.roles.some(role => role.id !== id && role.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, '角色名称已存在');
    const keys = new Set<string>(), secrets = new Set<string>(), paths: string[] = [];
    for (const item of input.connections) {
      toolName(item.tool);
      if (!CONNECTION_ALIAS.test(item.alias)) throw new HttpError(400, '连接名称无效');
      const key = `${item.tool}:${namedConnectionTool(item.tool) ? item.alias : ''}`;
      if (keys.has(key) || secrets.has(item.secretId)) throw new HttpError(400, '连接名称或凭证重复；仅 MySQL 和 Kubernetes 支持多个连接');
      keys.add(key); secrets.add(item.secretId);
      const secret = await this.repository.get(item.secretId);
      if (!secret?.enabled || secret.format !== 'text' || secret.tool !== item.tool || !secret.path) throw new HttpError(400, '请选择工具已启用的单文件凭证');
      const path = namedConnectionTool(item.tool) ? `.cocell/connections/${item.tool}/${secret.id}/config` : credentialPath(secret.path);
      if (paths.some(other => other === path || other.startsWith(path + '/') || path.startsWith(other + '/'))) throw new HttpError(400, '角色凭证路径冲突');
      paths.push(path);
    }
    const now = new Date().toISOString();
    const role = { id: id ?? randomUUID(), name, connections: input.connections.map(item => ({ ...item })), createdAt: previous?.createdAt ?? now, updatedAt: now };
    await this.repository.roles.saveRole(role, id ? 'update' : 'create');
    await this.refresh((await this.repository.roles.assignments()).filter(item => item.roleId === role.id).map(item => item.projectId));
    return role;
  }
  async delete(id: string) { await this.repository.roles.deleteRole(id); return { ok: true }; }
  async setDefault(roleId: string) { await this.repository.roles.setDefault(roleId); return this.catalog(); }
  async state(projectId: string): Promise<ProjectRoleState> {
    const assignment = await this.repository.roles.assignment(projectId);
    if (!assignment) return { roleId: null, connections: [] };
    const role = assignment.roleId ? (await this.catalog()).roles.find(role => role.id === assignment.roleId) : undefined;
    return { roleId: assignment.roleId, connections: role?.connections ?? [] };
  }
  async assign(projectId: string, roleId: string | null) {
    await this.repository.roles.assign(projectId, roleId);
    await this.refresh([projectId]);
    return this.state(projectId);
  }
  async grants(projectId: string): Promise<ProjectToolGrant[]> {
    const state = await this.state(projectId);
    const grants: ProjectToolGrant[] = [];
    for (const connection of state.connections) {
      const secret = await this.repository.get(connection.secretId);
      // Deletion, disablement, or changing a secret's tool revokes access immediately.
      if (!secret?.enabled || secret.tool !== connection.tool || secret.format !== 'text' || !secret.path) continue;
      grants.push({ id: connection.secretId, projectId, tool: connection.tool, alias: connection.alias,
        files: [{ secretId: secret.id, path: secret.path }], enabled: true, updatedAt: secret.updatedAt });
    }
    return grants;
  }
  async allGrants() {
    const assignments = await this.repository.roles.assignments();
    return (await Promise.all(assignments.map(item => this.grants(item.projectId)))).flat();
  }
}

/** A selector is consumed by CoCell, never passed to a native CLI. */
export function selectConnection(tool: string, args: string[], grants: ProjectToolGrant[]) {
  let alias: string | undefined;
  const checked: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { checked.push(...args.slice(i)); break; }
    if (arg === '--connection' || arg.startsWith('--connection=')) {
      const value = arg === '--connection' ? args[++i] : arg.slice('--connection='.length);
      if (!namedConnectionTool(tool) || alias !== undefined || !CONNECTION_ALIAS.test(value ?? '')) throw new HttpError(400, '连接选择无效');
      alias = value;
    } else checked.push(arg);
  }
  const matches = alias === undefined ? grants : grants.filter(grant => grant.alias === alias);
  if (matches.length !== 1) throw new HttpError(403, matches.length ? `请使用 --connection=名称 选择一个已授权连接：${matches.map(grant => grant.alias).join(', ')}` : '项目未授权此连接');
  return { grant: matches[0], args: checked };
}
