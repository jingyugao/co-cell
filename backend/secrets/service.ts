import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ToolAuthorization, ToolCatalogEntry } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import type { DynamicTools } from '../tools/service.js';
import { ToolScripts } from '../tools/scripts.js';
import { ToolCredentialFiles } from '../tools/credentials.js';
import { MountedToolHomes } from './mounted-home.js';
import { toolName, validateToolArgs } from './policy.js';
import type { SecretRepository } from './repository.js';
import { ToolRoles } from './roles.js';

/** Tool authorization owns metadata; native credential files are authoritative. */
export class SecretService {
  homes?: MountedToolHomes;
  credentialFiles?: ToolCredentialFiles;
  readonly roles: ToolRoles;
  readonly scripts: ToolScripts;
  constructor(readonly repository: SecretRepository, readonly tools: DynamicTools) {
    this.roles = new ToolRoles(repository, () => this.toolCatalog(), action => tools.coordinate(action));
    this.scripts = new ToolScripts(tools.repository.scripts, action => tools.coordinate(action));
  }
  async init() {
    await this.repository.init();
    await this.repository.roles.bootstrap();
  }
  async mountHomes(root: string) {
    this.homes = new MountedToolHomes(root);
    await this.homes.init();
    this.scripts.configureCache(join(root, 'tools/npm-cache'));
    this.credentialFiles = new ToolCredentialFiles(root, name => this.credentialConfiguration(name), action => this.tools.coordinate(action));
  }
  private async credentialConfiguration(name: string) {
    const definition = await this.tools.get(toolName(name));
    if (!definition) throw new HttpError(404, '工具不存在');
    const roots = definition.credentialPaths?.length ? definition.credentialPaths : definition.credentialPath ? [definition.credentialPath] : [];
    const [load, save] = await Promise.all([
      definition.credentialParseScriptId ? this.scripts.get(definition.credentialParseScriptId) : undefined,
      definition.credentialSaveScriptId ? this.scripts.get(definition.credentialSaveScriptId) : undefined,
    ]);
    const context = { ...definition.credentialContext, tool: name, ...(definition.credentialPath ? { primaryPath: definition.credentialPath } : {}) };
    const excludedPaths = definition.credentialExcludedPaths ?? [];
    const revision = JSON.stringify([definition.version, roots, excludedPaths, context, load?.id, load?.version, save?.id, save?.version]);
    return { roots, excludedPaths, context, load, save, scriptVersion: parseInt(createHash('sha256').update(revision).digest('hex').slice(0, 12), 16) };
  }
  async toolCatalog(): Promise<ToolCatalogEntry[]> {
    const catalog: ToolCatalogEntry[] = [];
    // Hooks use bounded workers, so one catalog request must not flood the pool.
    for (const definition of await this.tools.list()) {
      const name = definition.name;
      if (definition.credentialMode !== 'named') {
        catalog.push({ name, kind: 'tool' });
        continue;
      }
      if (!definition.credentialPath || !definition.credentialParseScriptId || !definition.permissionScriptId)
        throw new HttpError(503, '多凭据工具配置不完整');
      const file = await this.homes?.hasFile(definition.credentialPath)
        ? await this.credentialFiles!.read(name, definition.credentialPath) : undefined;
      const names = file?.names;
      if (file && (!names || names.some(name => !name || /[\u0000-\u001f\u007f]/.test(name)) || new Set(names).size !== names.length))
        throw new HttpError(400, '多凭据工具的 Load hook 必须返回唯一且非空的 names');
      catalog.push({ name, kind: 'tool-with-credential', credentials: names ?? [] });
    }
    return catalog;
  }
  registerRuntime(boxId: string, projectId: string, generation: number) {
    return this.repository.registerRuntime(boxId, projectId, generation);
  }
  /** Checks current grants and scripts without reading any credential contents. */
  async authorize(boxId: string, tool: string, args: string[]): Promise<ToolAuthorization> {
    const identity = await this.repository.runtime(boxId);
    if (!identity) throw new HttpError(404, 'Box 未绑定项目');
    const definition = await this.tools.get(toolName(tool));
    if (!definition) throw new HttpError(404, '工具未注册或已删除');
    if (!definition.enabled) throw new HttpError(403, '此工具已停用');
    const permission = (await this.roles.state(identity.projectId)).permissions.find(permission => permission.tool === tool);
    if (!permission?.enabled) throw new HttpError(403, '项目未授权此工具');
    if (permission.credentials !== undefined && definition.credentialMode !== 'named')
      throw new HttpError(403, '工具凭据授权模式不匹配，请更新动态定义');
    if (definition.credentialMode === 'named' && (!definition.permissionScriptId || !definition.credentialParseScriptId ||
        !definition.credentialPath || !permission.credentials?.length))
      throw new HttpError(403, '项目未授权此工具的具名凭据');
    const checked = validateToolArgs(tool, args);
    const decision = await this.scripts.checkPermission(definition, { tool, args: checked, boxId, projectId: identity.projectId, permission });
    if (definition.credentialMode === 'named' && (!decision?.credential || !permission.credentials!.includes(decision.credential)))
      throw new HttpError(403, '权限脚本必须选择项目已授权的凭据');
    const execution = await this.tools.execution(definition);
    if (!definition.credentialPath && Object.values(execution.env).some(value => value.includes('${CREDENTIAL}')))
      throw new HttpError(409, '请先配置认证文件路径');
    return { tool, args: checked, home: '/home/debug', execution,
      ...(definition.credentialPath ? { path: definition.credentialPath } : {}),
      credentialPaths: definition.credentialPaths?.length ? definition.credentialPaths : definition.credentialPath ? [definition.credentialPath] : [] };
  }
}
