import { randomUUID } from 'node:crypto';
import type { ProjectRoleState, ProjectToolGrant, RoleConnection, ToolRoleInput } from '../../protocol/secret-types.js';
import type { SecretRepository, StoredSecret } from './repository.js';
import { HttpError } from '../../util/errors.js';
import { credentialPath, toolName } from './policy.js';
import { nativeConfigPath, nativeContextTool } from './native-config.js';

const validConnectionName = (value: string) => value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);

/** Roles select credentials; database grants and cluster RBAC enforce resource permissions. */
export class ToolRoles {
  constructor(private repository: SecretRepository, private refresh: (projectIds: string[]) => Promise<void>,
    private profiles: (secret: StoredSecret) => string[] | undefined,
    private validate: (secrets: StoredSecret[]) => void) {}
  private describe(secret: StoredSecret | null, connection: RoleConnection): RoleConnection {
    const nativeNames = secret ? this.profiles(secret) : undefined;
    return { ...connection, alias: secret?.name ?? connection.alias, ...(nativeNames ? { nativeNames } : {}) };
  }
  async catalog() {
    const catalog = await this.repository.roles.catalog();
    const secrets = new Map((await this.repository.list()).map(secret => [secret.id, secret]));
    return { ...catalog, roles: catalog.roles.map(role => ({ ...role,
      connections: role.connections.map(connection => this.describe(secrets.get(connection.secretId) ?? null, connection)),
    })) };
  }
  async save(input: ToolRoleInput, id?: string) {
    const catalog = await this.catalog();
    const previous = id ? catalog.roles.find(role => role.id === id) : undefined;
    if (id && !previous) throw new HttpError(404, '角色不存在');
    const name = input.name.trim();
    if (!name || name.length > 100 || input.connections.length > 256) throw new HttpError(400, '角色名称或连接数量无效');
    if (catalog.roles.some(role => role.id !== id && role.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, '角色名称已存在');
    const keys = new Set<string>(), secrets = new Set<string>(), paths: Array<{ path: string; tool: string }> = [];
    const connections: RoleConnection[] = [];
    const selected: StoredSecret[] = [];
    for (const item of input.connections) {
      toolName(item.tool);
      const secret = await this.repository.get(item.secretId);
      if (!secret?.enabled || !['text', 'lark', 'home'].includes(secret.format) || secret.tool !== item.tool || !secret.path) throw new HttpError(400, '请选择工具已启用的凭据');
      if (!validConnectionName(secret.name)) throw new HttpError(400, '凭证名称不能为空、超过 100 个字符或包含控制字符');
      const key = `${item.tool}:${nativeContextTool(item.tool) ? secret.id : ''}`;
      if (keys.has(key) || secrets.has(item.secretId)) throw new HttpError(400, '凭证名称或凭证重复；仅 MySQL 和 Kubernetes 支持多个连接');
      keys.add(key); secrets.add(item.secretId);
      connections.push({ tool: item.tool, secretId: item.secretId, alias: secret.name });
      selected.push(secret);
      const path = nativeContextTool(item.tool) ? nativeConfigPath(item.tool) : credentialPath(secret.path);
      const reserved = secret.format === 'lark' ? ['.lark-cli', '.local/share/lark-cli'] : [path];
      if (reserved.some(path => paths.some(other => (other.path === path && other.tool !== item.tool) || other.path.startsWith(path + '/') || path.startsWith(other.path + '/')))) throw new HttpError(400, '角色凭证路径冲突');
      paths.push(...reserved.map(path => ({ path, tool: item.tool })));
    }
    this.validate(selected);
    const now = new Date().toISOString();
    const role = { id: id ?? randomUUID(), name, connections, createdAt: previous?.createdAt ?? now, updatedAt: now };
    await this.repository.roles.saveRole(role, id ? 'update' : 'create');
    await this.refresh((await this.repository.roles.assignments()).filter(item => item.roleId === role.id).map(item => item.projectId));
    return { ...role, connections: role.connections.map(connection => this.describe(selected.find(secret => secret.id === connection.secretId)!, connection)) };
  }
  async delete(id: string) { await this.repository.roles.deleteRole(id); return { ok: true }; }
  async setDefault(roleId: string) { await this.repository.roles.setDefault(roleId); return this.catalog(); }
  async state(projectId: string): Promise<ProjectRoleState> {
    const assignment = await this.repository.roles.assignment(projectId);
    if (!assignment) return { roleId: null, connections: [] };
    const role = assignment.roleId ? (await this.repository.roles.catalog()).roles.find(role => role.id === assignment.roleId) : undefined;
    const connections = await Promise.all((role?.connections ?? []).map(async connection => this.describe(await this.repository.get(connection.secretId), connection)));
    return { roleId: assignment.roleId, connections };
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
      if (!secret?.enabled || secret.tool !== connection.tool || !['text', 'lark', 'home'].includes(secret.format) || !secret.path) continue;
      grants.push({ id: connection.secretId, projectId, tool: connection.tool, alias: secret.name,
        files: [{ secretId: secret.id, path: secret.path }], enabled: true, updatedAt: secret.updatedAt, nativeNames: connection.nativeNames });
    }
    return grants;
  }
  async allGrants() {
    const assignments = await this.repository.roles.assignments();
    return (await Promise.all(assignments.map(item => this.grants(item.projectId)))).flat();
  }
}
