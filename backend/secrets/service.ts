import { larkCredential, type LarkCredential } from './lark-credential.js';
import { ToolRoles, connectionPath, selectConnection } from './roles.js';
import { randomUUID } from 'node:crypto';
import type { ProxyTool, SecretInput, SecretUpdate, SecretMetadata, SecretContent, SecretDeleteResult, ProvisionedToolFile } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import { SecretCrypto } from './crypto.js';
import { credentialPath, toolName, validateToolArgs } from './policy.js';
import type { SecretRepository, StoredSecret, StoredVersion } from './repository.js';
import { validateFileBundle } from '../../util/credential-files.mjs';
import { MountedToolHomes } from './mounted-home.js';
import type { ToolAuthorization } from '../../protocol/secret-types.js';
import type { SharedCoordinator } from '../infra/storage/coordination.js';

export const MAX_SECRET_BYTES = 64 * 1024;
export function secretBytes(format: SecretInput['format'], content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  if (format !== 'text' || !bytes.length || bytes.length > MAX_SECRET_BYTES || bytes.toString('utf8') !== content)
    throw new HttpError(400, '请提供最多 64 KiB 的原生文本认证文件');
  return bytes;
}
function fileBundle(input: unknown) {
  try { return validateFileBundle(input); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
}
function inputBytes(input: SecretInput & { supportVersion?: number }): Buffer {
  if (input.format !== 'text') throw new HttpError(400, '只支持原生文本认证文件');
  if (input.files || input.directory || input.adapter || input.identity || input.content === undefined) throw new HttpError(400, '单文件请提供 content');
  const bytes = secretBytes('text', input.content);
  return input.supportFiles ? Buffer.from(JSON.stringify(larkCredential(input.tool, input.path, input.content, input.supportFiles, input.supportVersion))) : bytes;
}
export class SecretService {
  homes?: MountedToolHomes;
  readonly roles: ToolRoles;
  constructor(readonly repository: SecretRepository, private crypto: SecretCrypto) {
    this.roles = new ToolRoles(repository, ids => this.refreshHomes(ids));
  }
  async init() {
    await this.repository.init();
    await this.repository.roles.bootstrap();
    // Reconcile every existing HOME before accepting traffic. This also removes
    // credentials left by the previous project-permission model after migration.
    await this.refreshHomes((await this.repository.roles.assignments()).map(item => item.projectId));
  }
  async mountHomes(root: string, coordinator?: SharedCoordinator) { this.homes = new MountedToolHomes(root, coordinator); await this.homes.init(); }
  publishHome(projectId: string) {
    if (!this.homes) throw new Error('Mounted debug HOME is not configured');
    return this.homes.publish(projectId, () => this.provision(projectId));
  }
  private async refreshHomes(projectIds: string[]) {
    if (!this.homes) return;
    for (const projectId of new Set(projectIds)) {
      if (await this.homes.exists(projectId)) await this.publishHome(projectId);
    }
  }
  private async boundProjects(secretId: string) {
    const [catalog, assignments] = await Promise.all([this.roles.catalog(), this.repository.roles.assignments()]);
    const roles = new Set(catalog.roles.filter(role => role.connections.some(connection => connection.secretId === secretId)).map(role => role.id));
    return assignments.filter(item => item.roleId && roles.has(item.roleId)).map(item => item.projectId);
  }

  private metadata(secret: StoredSecret, projectIds: string[] = []): SecretMetadata {
    const { ciphertext: _ciphertext, currentVersionId: _versionId, alias: _alias, format, ...metadata } = secret;
    const bundle = format === 'files' ? this.bundle(secret) : null;
    const native = format === 'lark' ? this.lark(secret) : null;
    return { ...metadata, ...(native ? { supportFilePaths: native.supportFiles.map(file => file.path) } : {}), format: format === 'files' ? 'files' : 'text', requiresTextImport: !['text', 'lark'].includes(format), projectIds,
      ...(bundle ? { filePaths: bundle.files.map(file => file.path), directory: bundle.directory, adapter: bundle.adapter, identity: bundle.identity } : {}) };
  }
  private lark(secret: StoredSecret): LarkCredential {
    let payload;
    try { payload = JSON.parse(this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8')); } catch { throw new HttpError(400, 'Lark 凭证格式无效'); }
    return larkCredential(secret.tool!, secret.path!, payload.content, payload.supportFiles, payload.supportVersion);
  }
  private bundle(secret: StoredSecret) { return fileBundle(JSON.parse(this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8'))); }
  async list() {
    const [secrets, grants] = await Promise.all([this.repository.list(), this.roles.allGrants()]);
    return secrets.map(secret => this.metadata(secret, [...new Set(grants.filter(g => g.files.some(f => f.secretId === secret.id)).map(g => g.projectId))]));
  }
  private validateConfig(secret: StoredSecret) {
    if (!['text', 'lark'].includes(secret.format)) throw new HttpError(400, '每份凭证只支持一个原生文本认证文件，请重新导入');
    if (!secret.tool || !secret.path) throw new HttpError(400, '请填写工具名和认证文件路径');
    toolName(secret.tool);
    credentialPath(secret.path);
    if (secret.format === 'lark') this.lark(secret);
  }

  private async requireSecret(id: string) { const secret = await this.repository.get(id); if (!secret) throw new HttpError(404, 'Secret 不存在'); return secret; }
  async content(id: string): Promise<SecretContent> {
    const secret = await this.requireSecret(id), bytes = this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext);
    if (secret.format === 'lark') { const value = this.lark(secret); return { format: 'text', content: value.content, supportFilePaths: value.supportFiles.map(file => file.path), requiresTextImport: false, version: secret.version }; }
    if (secret.format === 'files') return { format: 'files', content: '', ...this.bundle(secret), requiresTextImport: false, version: secret.version };
    return { format: 'text', content: secret.format === 'binary' ? '' : bytes.toString('utf8'), requiresTextImport: secret.format !== 'text', version: secret.version };
  }
  async create(input: SecretInput) {
    const id = randomUUID(), versionId = randomUUID(), now = new Date().toISOString();
    const bytes = inputBytes(input), ciphertext = this.crypto.seal(id, versionId, bytes);
    const secret: StoredSecret = { id, name: input.name, format: input.supportFiles ? 'lark' : input.format, mutable: input.mutable, enabled: true, version: 0, currentVersionId: versionId, ciphertext, createdAt: now, updatedAt: now,
      tool: input.tool, path: input.path, alias: 'default' };
    this.validateConfig(secret);
    await this.repository.save(secret, { id: versionId, secretId: id, ciphertext, source: 'operator', baseVersion: null, createdAt: now, projectId: null, invocationId: null, changes: ['created'] });
    return this.metadata(await this.requireSecret(id));
  }
  async update(id: string, input: SecretUpdate) {
    const secret = await this.requireSecret(id), now = new Date().toISOString();
    const contentChanged = input.content !== undefined || input.files !== undefined || input.supportFiles !== undefined;
    const previousLark = secret.format === 'lark' ? this.lark(secret) : null;
    if (!contentChanged && (input.format !== undefined || input.directory !== undefined || input.identity !== undefined || input.adapter !== undefined)) throw new HttpError(400, '更改文件格式或加密身份时请提交完整内容');
    const next: StoredSecret = { ...secret, name: input.name ?? secret.name, mutable: input.mutable ?? secret.mutable,
      enabled: input.enabled ?? secret.enabled, tool: input.tool ?? secret.tool, path: input.path ?? secret.path,
      alias: secret.alias ?? 'default', format: contentChanged ? input.format === 'files' ? 'files' : (input.supportFiles || previousLark) ? 'lark' : 'text' : secret.format, updatedAt: now };
    const changes = Object.keys(input).filter(key => key === 'content' || input[key as keyof typeof input] !== secret[key as keyof StoredSecret]);
    if (contentChanged && !changes.includes('content')) changes.push('content');
    if (!changes.length) return this.metadata(secret);
    const bytes = !contentChanged ? this.crypto.open(id, secret.currentVersionId, secret.ciphertext)
      : inputBytes({ ...input, name: next.name, mutable: next.mutable, tool: next.tool!, path: next.path!, content: input.content ?? previousLark?.content, supportFiles: input.supportFiles ?? previousLark?.supportFiles, supportVersion: input.supportFiles ? (previousLark?.supportVersion ?? 0) + 1 : previousLark?.supportVersion, format: next.format === 'lark' ? 'text' : next.format as SecretInput['format'] });
    const versionId = randomUUID(), ciphertext = this.crypto.seal(id, versionId, bytes);
    if (changes.some(key => ['tool', 'path', 'content'].includes(key))) this.validateConfig({ ...next, currentVersionId: versionId, ciphertext });
    if (changes.some(key => ['tool', 'path'].includes(key))) {
      const incompatible = (await this.roles.allGrants()).some(grant => grant.files.some(file => file.secretId === id
        && (grant.tool !== next.tool || file.path !== next.path)));
      if (incompatible) throw new HttpError(400, '密钥已被项目使用，不能更改工具或认证文件配置');
    }
    const version: StoredVersion = { id: versionId, secretId: id, ciphertext, source: 'operator', baseVersion: secret.version, createdAt: now, projectId: null, invocationId: null, changes };
    const { content: _content, ...stored } = next as StoredSecret & { content?: string };
    await this.repository.save(stored, version);
    await this.refreshHomes(await this.boundProjects(id));
    return this.metadata(await this.requireSecret(id));
  }
  async versions(id: string) { await this.requireSecret(id); return (await this.repository.versions(id)).map(({ ciphertext: _ciphertext, secretId: _id, ...metadata }) => metadata); }
  async delete(id: string): Promise<SecretDeleteResult> {
    const projects = await this.boundProjects(id);
    await this.repository.delete(id); await this.refreshHomes(projects); return { ok: true };
  }
  /** Resolve selected files at provisioning time, never on the CLI execution path. */
  async provision(projectId: string): Promise<ProvisionedToolFile[]> {
    const grants = (await this.roles.grants(projectId)).filter(grant => grant.enabled);
    const files: ProvisionedToolFile[] = [];
    for (const grant of grants) {
      if (grant.files.length !== 1) continue;
      const binding = grant.files[0], secret = await this.repository.get(binding.secretId);
      if (!secret?.enabled || !['text', 'lark'].includes(secret.format)) continue;
      if (secret.tool && (secret.tool !== grant.tool || secret.path !== binding.path)) continue;
      toolName(grant.tool); credentialPath(binding.path);
      const native = secret.format === 'lark' ? this.lark(secret) : null;
      const content = native ? Buffer.from(native.content).toString('base64') : this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('base64');
      files.push({ tool: grant.tool, secretId: secret.id, path: connectionPath(grant), content, mutable: secret.mutable, version: secret.version,
        alias: grant.alias });
      for (const file of native?.supportFiles ?? []) files.push({ tool: grant.tool, secretId: secret.id, path: file.path, content: file.content, mutable: secret.mutable, version: native!.supportVersion, alias: grant.alias });
    }
    return files.sort((a, b) => a.tool.localeCompare(b.tool));
  }
  async registerRuntime(boxId: string, projectId: string, generation: number) {
    await this.repository.registerRuntime(boxId, projectId, generation);
    return boxId;
  }
  private async runtimeIdentity(boxId: string) {
    const runtime = await this.repository.runtime(boxId);
    if (!runtime) throw new HttpError(404, 'Box 未绑定项目');
    return { boxId, ...runtime };
  }
  /** Authorization returns a path and checked arguments, never credential bytes. */
  async authorize(boxId: string, tool: ProxyTool, args: string[]): Promise<ToolAuthorization> {
    const identity = await this.runtimeIdentity(boxId);
    const grants = (await this.roles.grants(identity.projectId)).filter(grant => grant.enabled && grant.tool === tool);
    const selected = selectConnection(tool, args, grants), grant = selected.grant;
    if (grant.files.length !== 1) throw new HttpError(403, '项目未授权此工具的单文件凭证');
    const binding = grant.files[0], secret = await this.requireSecret(binding.secretId);
    if (!secret.enabled || !['text', 'lark'].includes(secret.format) || (secret.tool && (secret.tool !== tool || secret.path !== binding.path)))
      throw new HttpError(403, '工具凭证已停用或需要重新配置');
    const path = credentialPath(connectionPath(grant)), checked = validateToolArgs(tool, selected.args);
    if (!this.homes || !await this.homes.ready(identity.projectId, { tool, secretId: secret.id, path, version: secret.version }))
      throw new HttpError(409, '凭证尚未更新到 debug HOME，请重新保存工具选择');
    return { tool, args: checked, home: `/home/debug/${identity.projectId}`, path };
  }
}
