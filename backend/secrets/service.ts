import { larkCredential, type LarkCredential } from './lark-credential.js';
import { ToolRoles } from './roles.js';
import { mergeNativeConfig, mergedBinding, nativeContextTool, nativeNames, type NativeSource } from './native-config.js';
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
  if (input.format === 'home') {
    if (!/^[a-f0-9-]{36}$/.test(input.homeProjectId ?? '') || input.content !== undefined || input.files || input.supportFiles || input.directory || input.adapter || input.identity)
      throw new HttpError(400, 'HOME 凭据只需要来源项目，不接受凭据内容');
    return Buffer.from(JSON.stringify({ homeProjectId: input.homeProjectId }));
  }
  if (input.format !== 'text') throw new HttpError(400, '只支持原生文本认证文件');
  if (input.homeProjectId !== undefined) throw new HttpError(400, '来源项目只用于 HOME 引用');
  if (input.files || input.directory || input.adapter || input.identity || input.content === undefined) throw new HttpError(400, '单文件请提供 content');
  const bytes = secretBytes('text', input.content);
  return input.supportFiles ? Buffer.from(JSON.stringify(larkCredential(input.tool, input.path, input.content, input.supportFiles, input.supportVersion))) : bytes;
}
export class SecretService {
  homes?: MountedToolHomes;
  readonly roles: ToolRoles;
  constructor(readonly repository: SecretRepository, private crypto: SecretCrypto, private homeProjectAvailable: (id: string) => Promise<boolean> = async () => false) {
    this.roles = new ToolRoles(repository, ids => this.refreshHomes(ids), secret => this.profiles(secret), secrets => this.validateSelected(secrets));
  }
  private nativeSource(secret: StoredSecret): NativeSource {
    return { id: secret.id, name: secret.name, version: secret.version, content: this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8') };
  }
  private profiles(secret: StoredSecret) {
    return secret.format === 'text' && nativeContextTool(secret.tool!) ? nativeNames(secret.tool!, this.nativeSource(secret)) : undefined;
  }
  private validateSelected(secrets: StoredSecret[]) {
    for (const tool of ['mysql', 'kubectl']) {
      const sources = secrets.filter(secret => secret.enabled && secret.tool === tool).map(secret => this.nativeSource(secret));
      if (sources.length) mergeNativeConfig(tool, sources);
    }
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
    const nativeNames = this.profiles(secret);
    return { ...metadata, ...(format === 'home' ? { homeProjectId: this.homeProject(secret) } : {}), ...(nativeNames ? { nativeNames } : {}), ...(native ? { supportFilePaths: native.supportFiles.map(file => file.path) } : {}), format: format === 'files' ? 'files' : format === 'home' ? 'home' : 'text', requiresTextImport: !['text', 'lark', 'home'].includes(format), projectIds,
      ...(bundle ? { filePaths: bundle.files.map(file => file.path), directory: bundle.directory, adapter: bundle.adapter, identity: bundle.identity } : {}) };
  }
  private lark(secret: StoredSecret): LarkCredential {
    let payload;
    try { payload = JSON.parse(this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8')); } catch { throw new HttpError(400, 'Lark 凭证格式无效'); }
    return larkCredential(secret.tool!, secret.path!, payload.content, payload.supportFiles, payload.supportVersion);
  }
  private bundle(secret: StoredSecret) { return fileBundle(JSON.parse(this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8'))); }
  private homeProject(secret: StoredSecret): string {
    try {
      const value = JSON.parse(this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8')).homeProjectId;
      if (!/^[a-f0-9-]{36}$/.test(value ?? '')) throw new Error();
      return value;
    } catch { throw new HttpError(400, 'HOME 凭据缺少有效的来源项目'); }
  }
  async list() {
    const [secrets, grants] = await Promise.all([this.repository.list(), this.roles.allGrants()]);
    return secrets.map(secret => this.metadata(secret, [...new Set(grants.filter(g => g.files.some(f => f.secretId === secret.id)).map(g => g.projectId))]));
  }
  private validateConfig(secret: StoredSecret) {
    if (!['text', 'lark', 'home'].includes(secret.format)) throw new HttpError(400, '每份凭证只支持原生文本文件或项目 HOME 引用，请重新导入');
    if (!secret.tool || !secret.path) throw new HttpError(400, '请填写工具名和认证文件路径');
    toolName(secret.tool);
    credentialPath(secret.path);
    if (secret.format === 'lark') this.lark(secret);
    if (secret.format === 'home') {
      this.homeProject(secret);
      if (nativeContextTool(secret.tool!)) throw new HttpError(400, 'MySQL 和 Kubernetes 请继续使用原生连接配置');
    }
    this.profiles(secret);
  }

  private async requireSecret(id: string) { const secret = await this.repository.get(id); if (!secret) throw new HttpError(404, 'Secret 不存在'); return secret; }
  async content(id: string): Promise<SecretContent> {
    const secret = await this.requireSecret(id), bytes = this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext);
    if (secret.format === 'home') return { format: 'home', content: '', homeProjectId: this.homeProject(secret), requiresTextImport: false, version: secret.version };
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
    const contentChanged = input.content !== undefined || input.files !== undefined || input.supportFiles !== undefined || input.homeProjectId !== undefined;
    const previousLark = secret.format === 'lark' ? this.lark(secret) : null;
    if (!contentChanged && (input.format !== undefined || input.directory !== undefined || input.identity !== undefined || input.adapter !== undefined)) throw new HttpError(400, '更改文件格式或加密身份时请提交完整内容');
    const next: StoredSecret = { ...secret, name: input.name ?? secret.name, mutable: input.mutable ?? secret.mutable,
      enabled: input.enabled ?? secret.enabled, tool: input.tool ?? secret.tool, path: input.path ?? secret.path,
      alias: secret.alias ?? 'default', format: contentChanged ? input.format === 'home' ? 'home' : input.format === 'files' ? 'files' : (input.supportFiles || previousLark) ? 'lark' : 'text' : secret.format, updatedAt: now };
    const changes = Object.keys(input).filter(key => key === 'content' || input[key as keyof typeof input] !== secret[key as keyof StoredSecret]);
    if (contentChanged && !changes.includes('content')) changes.push('content');
    if (!changes.length) return this.metadata(secret);
    const bytes = !contentChanged ? this.crypto.open(id, secret.currentVersionId, secret.ciphertext)
      : inputBytes({ ...input, name: next.name, mutable: next.mutable, tool: next.tool!, path: next.path!, content: next.format === 'home' ? input.content : input.content ?? previousLark?.content, supportFiles: next.format === 'home' ? input.supportFiles : input.supportFiles ?? previousLark?.supportFiles, supportVersion: input.supportFiles ? (previousLark?.supportVersion ?? 0) + 1 : previousLark?.supportVersion, format: next.format === 'lark' ? 'text' : next.format as SecretInput['format'] });
    const versionId = randomUUID(), ciphertext = this.crypto.seal(id, versionId, bytes);
    const candidate = { ...next, currentVersionId: versionId, ciphertext };
    this.validateConfig(candidate);
    if (nativeContextTool(next.tool!)) {
      const records = new Map((await this.repository.list()).map(secret => [secret.id, secret])); records.set(id, candidate);
      for (const role of (await this.repository.roles.catalog()).roles.filter(role => role.connections.some(connection => connection.secretId === id)))
        this.validateSelected(role.connections.flatMap(connection => records.get(connection.secretId) ?? []));
    }
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
    const nativeSources = new Map<string, NativeSource[]>();
    for (const grant of grants) {
      if (grant.files.length !== 1) continue;
      const binding = grant.files[0], secret = await this.repository.get(binding.secretId);
      if (!secret?.enabled || !['text', 'lark', 'home'].includes(secret.format)) continue;
      if (secret.tool && (secret.tool !== grant.tool || secret.path !== binding.path)) continue;
      toolName(grant.tool); credentialPath(binding.path);
      if (secret.format === 'home') {
        if (this.homeProject(secret) === projectId) files.push({ tool: grant.tool, secretId: secret.id, path: binding.path, content: '', mutable: true, version: secret.version, alias: grant.alias, externallyManaged: true });
        continue;
      }
      if (nativeContextTool(grant.tool)) {
        const sources = nativeSources.get(grant.tool) ?? []; sources.push(this.nativeSource(secret)); nativeSources.set(grant.tool, sources); continue;
      }
      const native = secret.format === 'lark' ? this.lark(secret) : null;
      const content = native ? Buffer.from(native.content).toString('base64') : this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('base64');
      files.push({ tool: grant.tool, secretId: secret.id, path: binding.path, content, mutable: secret.mutable, version: secret.version,
        alias: grant.alias });
      for (const file of native?.supportFiles ?? []) files.push({ tool: grant.tool, secretId: secret.id, path: file.path, content: file.content, mutable: secret.mutable, version: native!.supportVersion, alias: grant.alias });
    }
    for (const [tool, sources] of nativeSources) files.push(mergeNativeConfig(tool, sources));
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
    if (!grants.length) throw new HttpError(403, '项目未授权此工具');
    const checked = validateToolArgs(tool, args);
    if (nativeContextTool(tool)) {
      const secrets = await Promise.all(grants.map(async grant => this.requireSecret(grant.files[0].secretId)));
      if (tool === 'mysql') {
        const names = grants.flatMap(grant => grant.nativeNames ?? []);
        const loginPath = checked.find(arg => arg.startsWith('--login-path='))?.slice('--login-path='.length);
        if (loginPath && !names.includes(loginPath)) throw new HttpError(403, `项目未授权此 MySQL 原生连接；可用连接：${names.join(', ')}`);
        if (!loginPath && names.length > 1 && !checked.includes('--version') && !checked.includes('--help')) throw new HttpError(400, `请用 MySQL 原生 --login-path=名称 选择连接：${names.join(', ')}`);
      }
      const binding = mergedBinding(tool, secrets);
      if (!this.homes || !await this.homes.ready(identity.projectId, binding)) throw new HttpError(409, '凭证尚未更新到 debug HOME，请重新保存工具选择');
      return { tool, args: checked, home: `/home/debug/${identity.projectId}`, path: binding.path };
    }
    if (grants.length !== 1) throw new HttpError(403, '此工具不支持多个原生凭证');
    const grant = grants[0];
    if (grant.files.length !== 1) throw new HttpError(403, '项目未授权此工具的单文件凭证');
    const binding = grant.files[0], secret = await this.requireSecret(binding.secretId);
    if (secret.enabled && secret.format === 'home' && secret.tool === tool && secret.path === binding.path) {
      const projectId = this.homeProject(secret);
      if (!await this.homeProjectAvailable(projectId)) throw new HttpError(409, '凭据来源项目不可用');
      if (!this.homes || !await this.homes.hasFile(projectId, binding.path)) throw new HttpError(409, '凭据来源 HOME 中尚无认证文件，请先完成工具登录');
      return { tool, args: checked, home: `/home/debug/${projectId}`, path: binding.path };
    }
    if (!secret.enabled || !['text', 'lark'].includes(secret.format) || (secret.tool && (secret.tool !== tool || secret.path !== binding.path)))
      throw new HttpError(403, '工具凭证已停用或需要重新配置');
    const path = credentialPath(binding.path);
    if (!this.homes || !await this.homes.ready(identity.projectId, { tool, secretId: secret.id, path, version: secret.version }))
      throw new HttpError(409, '凭证尚未更新到 debug HOME，请重新保存工具选择');
    return { tool, args: checked, home: `/home/debug/${identity.projectId}`, path };
  }
}
