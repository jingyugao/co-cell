import { randomUUID } from 'node:crypto';
import type { ProjectRoleState, ToolCatalogEntry, ToolPermission, ToolRoleInput } from '../../protocol/secret-types.js';
import type { SecretRepository } from './repository.js';
import { HttpError } from '../../util/errors.js';
import { toolName } from './policy.js';

/** Roles contain access switches and native credential names, never Secret IDs. */
export class ToolRoles {
  constructor(private repository: SecretRepository, private tools: () => Promise<ToolCatalogEntry[]>) {}
  catalog() { return this.repository.roles.catalog(); }
  async save(input: ToolRoleInput, id?: string) {
    const catalog = await this.catalog();
    const previous = id ? catalog.roles.find(role => role.id === id) : undefined;
    if (id && !previous) throw new HttpError(404, '角色不存在');
    const name = input.name.trim();
    if (!name || name.length > 100 || input.permissions.length > 256) throw new HttpError(400, '角色名称或工具数量无效');
    if (catalog.roles.some(role => role.id !== id && role.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, '角色名称已存在');
    const available = new Map((await this.tools()).map(tool => [tool.name, tool]));
    const seen = new Set<string>();
    const permissions: ToolPermission[] = [];
    for (const permission of input.permissions) {
      toolName(permission.tool);
      if (seen.has(permission.tool)) throw new HttpError(400, '角色工具重复');
      seen.add(permission.tool);
      const tool = available.get(permission.tool);
      if (!tool) throw new HttpError(400, `工具不存在：${permission.tool}`);
      if (tool.kind === 'tool') {
        if (permission.credentials !== undefined) throw new HttpError(400, '此工具只支持使用权限开关');
        permissions.push({ tool: tool.name, enabled: permission.enabled });
        continue;
      }
      const names = permission.credentials ?? [];
      if (new Set(names).size !== names.length) throw new HttpError(400, '角色凭据重复');
      if (permission.enabled && !names.length) throw new HttpError(400, '请至少选择一个已启用的原生凭据');
      if (names.some(name => !tool.credentials.includes(name))) throw new HttpError(400, `所选 ${tool.name} 凭据不存在或已停用，请刷新列表`);
      permissions.push({ tool: tool.name, enabled: permission.enabled, credentials: [...names] });
    }
    const now = new Date().toISOString();
    const role = { id: id ?? randomUUID(), name, permissions, createdAt: previous?.createdAt ?? now, updatedAt: now };
    await this.repository.roles.saveRole(role, id ? 'update' : 'create');
    return role;
  }
  async delete(id: string) { await this.repository.roles.deleteRole(id); return { ok: true }; }
  async setDefault(roleId: string) { await this.repository.roles.setDefault(roleId); return this.catalog(); }
  async state(projectId: string): Promise<ProjectRoleState> {
    const assignment = await this.repository.roles.assignment(projectId);
    if (!assignment) return { roleId: null, permissions: [] };
    const role = assignment.roleId ? (await this.repository.roles.catalog()).roles.find(role => role.id === assignment.roleId) : undefined;
    return { roleId: assignment.roleId, permissions: role?.permissions ?? [] };
  }
  async assign(projectId: string, roleId: string | null) {
    await this.repository.roles.assign(projectId, roleId);
    return this.state(projectId);
  }
}
