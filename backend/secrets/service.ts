import { randomUUID } from 'node:crypto';
import type { ProjectToolGrant, ProjectToolGrantInput, ProjectToolSelection, ProxyTool, SecretInput, SecretUpdate, SecretMetadata, SecretContent, SecretDeleteResult, ToolInvocationSetup, ToolCompletionResult, ProvisionedToolFile, ToolFileUpdate } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import { SecretCrypto } from './crypto.js';
import { credentialPath, toolName, validateToolArgs } from './policy.js';
import type { SecretRepository, StoredSecret, StoredVersion } from './repository.js';
import { FILE_BUNDLE_LIMIT, openMeegleBundle, validateFileBundle } from '../../util/credential-files.mjs';

export const MAX_SECRET_BYTES = 64 * 1024;
export function secretBytes(format: SecretInput['format'], content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  if (!['text', 'files'].includes(format) || !bytes.length || bytes.length > (format === 'files' ? FILE_BUNDLE_LIMIT : MAX_SECRET_BYTES) || bytes.toString('utf8') !== content)
    throw new HttpError(400, '单文件最多 64 KiB，目录或文件组最多 512 KiB');
  return bytes;
}
function fileBundle(input: unknown) {
  try { return validateFileBundle(input); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
}
function inputBytes(input: SecretInput): Buffer {
  if (input.format === 'files') {
    if (input.content !== undefined) throw new HttpError(400, '文件组请使用 files 字段');
    const bundle = fileBundle(input);
    if (input.path !== bundle.files[0].path) throw new HttpError(400, '主文件路径必须是文件组的第一份文件');
    if (bundle.adapter === 'meegle') {
      if (input.tool !== 'meegle') throw new HttpError(400, 'Meegle 适配只能用于 meegle 工具');
      try { openMeegleBundle(bundle); } catch (error) { throw new HttpError(400, (error as Error).message); }
    }
    return secretBytes('files', JSON.stringify(bundle));
  }
  if (input.files || input.directory || input.adapter || input.identity || input.content === undefined) throw new HttpError(400, '单文件请提供 content');
  return secretBytes('text', input.content);
}
export class SecretService {
  constructor(readonly repository: SecretRepository, private crypto: SecretCrypto,
    private liveRuntime: (boxId: string) => Promise<{ generation: number; phase: string }>,
    private ownsRuntime: (projectId: string, boxId: string) => boolean) {}
  async init() { await this.repository.init(); }
  private metadata(secret: StoredSecret, projectIds: string[] = []): SecretMetadata {
    const { ciphertext: _ciphertext, currentVersionId: _versionId, alias: _alias, format, ...metadata } = secret;
    const bundle = format === 'files' ? this.bundle(secret) : null;
    return { ...metadata, format: format === 'files' ? 'files' : 'text', requiresTextImport: !['text', 'files'].includes(format), projectIds,
      ...(bundle ? { filePaths: bundle.files.map(file => file.path), directory: bundle.directory, adapter: bundle.adapter, identity: bundle.identity } : {}) };
  }
  private bundle(secret: StoredSecret) { return fileBundle(JSON.parse(this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8'))); }
  async list() {
    const [secrets, grants] = await Promise.all([this.repository.list(), this.repository.allGrants()]);
    return secrets.map(secret => this.metadata(this.withLegacyConfig(secret, grants), [...new Set(grants.filter(g => g.files.some(f => f.secretId === secret.id)).map(g => g.projectId))]));
  }
  private withLegacyConfig(secret: StoredSecret, grants: ProjectToolGrant[]): StoredSecret {
    if (secret.tool) return secret;
    const bindings = grants.flatMap(grant => grant.files.filter(file => file.secretId === secret.id)
      .map(file => ({ tool: grant.tool, path: file.path, alias: grant.alias })));
    const unique = [...new Map(bindings.map(value => [JSON.stringify(value), value])).values()];
    return unique.length === 1 ? { ...secret, ...unique[0] } : secret;
  }
  private validateConfig(secret: StoredSecret) {
    if (!['text', 'files'].includes(secret.format)) throw new HttpError(409, '旧格式密钥需要重新导入原始文本文件');
    if (!secret.tool || !secret.path) throw new HttpError(400, '请填写工具名和认证文件路径');
    toolName(secret.tool);
    credentialPath(secret.path);
    if (secret.format === 'files') {
      const bundle = this.bundle(secret);
      if (bundle.files[0].path !== secret.path || (bundle.adapter === 'meegle' && secret.tool !== 'meegle'))
        throw new HttpError(400, '文件组工具或主文件路径不匹配');
    }
  }
  private async requireSecret(id: string) { const secret = await this.repository.get(id); if (!secret) throw new HttpError(404, 'Secret 不存在'); return secret; }
  async content(id: string): Promise<SecretContent> {
    const secret = await this.requireSecret(id), bytes = this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext);
    if (secret.format === 'files') return { format: 'files', content: '', ...this.bundle(secret), requiresTextImport: false, version: secret.version };
    return { format: 'text', content: secret.format === 'binary' ? '' : bytes.toString('utf8'), requiresTextImport: secret.format !== 'text', version: secret.version };
  }
  async create(input: SecretInput) {
    const id = randomUUID(), versionId = randomUUID(), now = new Date().toISOString();
    const bytes = inputBytes(input), ciphertext = this.crypto.seal(id, versionId, bytes);
    const secret: StoredSecret = { id, name: input.name, format: input.format, mutable: input.mutable, enabled: true, version: 0, currentVersionId: versionId, ciphertext, createdAt: now, updatedAt: now,
      tool: input.tool, path: input.path, alias: 'default' };
    this.validateConfig(secret);
    await this.repository.save(secret, { id: versionId, secretId: id, ciphertext, source: 'operator', baseVersion: null, createdAt: now, projectId: null, invocationId: null, changes: ['created'] });
    return this.metadata(await this.requireSecret(id));
  }
  async update(id: string, input: SecretUpdate) {
    const secret = await this.requireSecret(id), now = new Date().toISOString();
    const contentChanged = input.content !== undefined || input.files !== undefined;
    if (!contentChanged && (input.format !== undefined || input.directory !== undefined || input.identity !== undefined || input.adapter !== undefined)) throw new HttpError(400, '更改文件格式或加密身份时请提交完整内容');
    const next: StoredSecret = { ...secret, name: input.name ?? secret.name, mutable: input.mutable ?? secret.mutable,
      enabled: input.enabled ?? secret.enabled, tool: input.tool ?? secret.tool, path: input.path ?? secret.path,
      alias: secret.alias ?? 'default', format: contentChanged ? input.format ?? (input.files ? 'files' : 'text') : secret.format, updatedAt: now };
    const changes = Object.keys(input).filter(key => key === 'content' || input[key as keyof typeof input] !== secret[key as keyof StoredSecret]);
    if (contentChanged && !changes.includes('content')) changes.push('content');
    if (!changes.length) return this.metadata(secret);
    const bytes = !contentChanged ? this.crypto.open(id, secret.currentVersionId, secret.ciphertext)
      : inputBytes({ ...input, name: next.name, mutable: next.mutable, tool: next.tool!, path: next.path!, format: next.format as SecretInput['format'] });
    const versionId = randomUUID(), ciphertext = this.crypto.seal(id, versionId, bytes);
    if (changes.some(key => ['tool', 'path', 'content'].includes(key))) this.validateConfig({ ...next, currentVersionId: versionId, ciphertext });
    if (changes.some(key => ['tool', 'path'].includes(key))) {
      const incompatible = (await this.repository.allGrants()).some(grant => grant.files.some(file => file.secretId === id
        && (grant.tool !== next.tool || file.path !== next.path)));
      if (incompatible) throw new HttpError(400, '密钥已被项目使用，不能更改工具或认证文件配置');
    }
    const version: StoredVersion = { id: versionId, secretId: id, ciphertext, source: 'operator', baseVersion: secret.version, createdAt: now, projectId: null, invocationId: null, changes };
    const { content: _content, ...stored } = next as StoredSecret & { content?: string };
    await this.repository.save(stored, version);
    return this.metadata(await this.requireSecret(id));
  }
  async versions(id: string) { await this.requireSecret(id); return (await this.repository.versions(id)).map(({ ciphertext: _ciphertext, secretId: _id, ...metadata }) => metadata); }
  async delete(id: string): Promise<SecretDeleteResult> { await this.repository.delete(id); return { ok: true }; }
  grants(projectId: string) { return this.repository.grants(projectId); }
  async saveGrant(projectId: string, input: ProjectToolGrantInput) {
    if (input.files.length !== 1) throw new HttpError(400, '每种工具只能选择一个密钥');
    const file = input.files[0], path = credentialPath(file.path), secret = await this.requireSecret(file.secretId);
    if (secret.tool && (secret.tool !== input.tool || secret.path !== path)) throw new HttpError(400, '密钥所属工具或文件路径不匹配');
    this.validateConfig({ ...secret, tool: input.tool, path });
    const existing = (await this.repository.grants(projectId)).find(g => g.tool === input.tool && g.alias === input.alias);
    const { policy: _legacy, ...binding } = input;
    const grant = { ...binding, id: existing?.id ?? randomUUID(), projectId, updatedAt: new Date().toISOString() };
    await this.repository.saveGrant(grant);
    return (await this.repository.grants(projectId)).find(value => value.tool === input.tool && value.alias === input.alias)!;
  }
  async saveSelections(projectId: string, selections: ProjectToolSelection[]) {
    if (selections.length > 256 || new Set(selections.map(value => value.tool)).size !== selections.length)
      throw new HttpError(400, '每种工具只能配置一次，最多 256 种工具');
    for (const { tool } of selections) toolName(tool);
    const [current, all] = await Promise.all([this.repository.grants(projectId), this.repository.allGrants()]);
    const grants: ProjectToolGrant[] = [];
    for (const { tool, secretId } of selections) {
      if (!secretId) continue;
      const secret = this.withLegacyConfig(await this.requireSecret(secretId), all);
      if (!secret.enabled || secret.tool !== tool) throw new HttpError(400, '请选择该工具已启用的密钥');
      this.validateConfig(secret);
      const files = [{ secretId, path: secret.path! }];
      const previous = current.find(grant => grant.tool === tool && JSON.stringify(grant.files) === JSON.stringify(files));
      grants.push({ id: previous?.id ?? randomUUID(), projectId, tool, alias: previous?.alias ?? 'default', files, enabled: true, updatedAt: new Date().toISOString() });
    }
    await this.repository.replaceGrants(projectId, grants);
    return this.repository.grants(projectId);
  }
  deleteGrant(projectId: string, id: string) { return this.repository.deleteGrant(projectId, id); }
  /** Resolve selected files at provisioning time, never on the CLI execution path. */
  async provision(projectId: string): Promise<ProvisionedToolFile[]> {
    const grants = (await this.repository.grants(projectId)).filter(grant => grant.enabled);
    const files: ProvisionedToolFile[] = [];
    for (const grant of grants) {
      if (grant.files.length !== 1 || grants.filter(value => value.tool === grant.tool).length !== 1) continue;
      const binding = grant.files[0], secret = await this.repository.get(binding.secretId);
      if (!secret?.enabled || !['text', 'files'].includes(secret.format)) continue;
      if (secret.tool && (secret.tool !== grant.tool || secret.path !== binding.path)) continue;
      toolName(grant.tool); credentialPath(binding.path);
      const content = this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('base64');
      files.push({ tool: grant.tool, secretId: secret.id, path: binding.path, content, mutable: secret.mutable, version: secret.version,
        ...(secret.format === 'files' ? { format: 'files' as const } : {}) });
    }
    return files.sort((a, b) => a.tool.localeCompare(b.tool));
  }
  async registerRuntime(boxId: string, projectId: string, generation: number) {
    await this.repository.registerRuntime(boxId, projectId, generation);
    return this.crypto.runtimeToken(boxId, generation);
  }
  private async runtimeIdentity(token: string) {
    const identity = this.crypto.verifyRuntimeToken(token);
    if (!identity) throw new HttpError(401, '工具认证无效');
    const runtime = await this.repository.runtime(identity.boxId);
    if (!runtime || runtime.generation !== identity.generation || !this.ownsRuntime(runtime.projectId, identity.boxId)) throw new HttpError(403, 'Sandbox 未绑定当前项目');
    return { ...identity, projectId: runtime.projectId };
  }
  private async authorize(token: string) {
    const identity = await this.runtimeIdentity(token);
    const live = await this.liveRuntime(identity.boxId);
    if (live.generation !== identity.generation || live.phase !== 'running') throw new HttpError(403, 'Sandbox 运行身份已失效');
    return identity;
  }
  /** Persist modified local files without checking the project's current selection. */
  async syncFiles(token: string, tool: ProxyTool, updates: ToolFileUpdate[], exitCode: number): Promise<ToolCompletionResult> {
    const identity = await this.runtimeIdentity(token), now = new Date().toISOString(), id = randomUUID();
    if (new Set(updates.map(update => update.secretId)).size !== updates.length) throw new HttpError(400, 'Secret 更新不可重复');
    const changes: Array<{ secret: StoredSecret; version: StoredVersion }> = [];
    for (const update of updates) {
      const secret = await this.repository.get(update.secretId);
      if (!secret?.enabled || !secret.mutable || !['text', 'files'].includes(secret.format)) continue;
      if (secret.tool !== tool) throw new HttpError(403, '不能更新其他工具的凭证');
      if (update.format !== undefined && secret.format !== update.format) throw new HttpError(409, '凭证格式已变更，请刷新运行环境后重试');
      if (secret.format === 'files' && secret.version !== update.baseVersion) throw new HttpError(409, '文件组已更新，请刷新运行环境后重试');
      const raw = Buffer.from(update.content, 'base64');
      if (raw.toString('base64') !== update.content) throw new HttpError(400, 'Secret 更新编码无效');
      if (!Buffer.from(raw.toString('utf8')).equals(raw)) throw new HttpError(400, '认证文件必须使用 UTF-8 编码');
      const bytes = this.updateBytes(secret, raw), versionId = randomUUID();
      changes.push({ secret, version: { id: versionId, secretId: secret.id, ciphertext: this.crypto.seal(secret.id, versionId, bytes), source: 'tool', baseVersion: update.baseVersion, createdAt: now, projectId: identity.projectId, invocationId: id, changes: ['content'] } });
    }
    if (!changes.length) return { saved: false, discarded: true };
    const invocation = { id, ...identity,
      grant: { id, projectId: identity.projectId, tool, alias: 'default', enabled: true, files: changes.map(({ secret }) => ({ secretId: secret.id, path: secret.path! })), updatedAt: now },
      files: changes.map(({ secret, version }) => ({ secretId: secret.id, path: secret.path!, version: version.baseVersion!, versionId: secret.currentVersionId })),
      createdAt: now, completedAt: now };
    await this.repository.startInvocation({ ...invocation, completedAt: null });
    try {
      const saved = await this.repository.completeInvocation(invocation, changes, exitCode);
      const versions = changes.filter(({ secret }) => secret.format === 'files').map(({ secret, version }) => ({ secretId: secret.id, version: version.baseVersion! + 1 }));
      return { saved, ...(saved && versions.length ? { versions } : {}) };
    }
    catch (error) {
      const resources = await Promise.all(changes.map(({ secret }) => this.repository.get(secret.id)));
      if (resources.every(secret => secret?.enabled && secret.mutable && ['text', 'files'].includes(secret.format))) throw error;
      await this.repository.completeInvocation(invocation, [], exitCode);
      return { saved: false, discarded: true };
    }
  }
  private updateBytes(secret: StoredSecret, raw: Buffer) {
    if (secret.format !== 'files') return secretBytes('text', raw.toString('utf8'));
    let incoming;
    try { incoming = fileBundle(JSON.parse(raw.toString('utf8'))); } catch { throw new HttpError(400, '文件组更新格式无效'); }
    const current = this.bundle(secret);
    if (incoming.adapter !== current.adapter || incoming.directory !== current.directory || (!current.directory && JSON.stringify(incoming.files.map(file => file.path)) !== JSON.stringify(current.files.map(file => file.path))))
      throw new HttpError(403, '工具不能修改文件组路径或适配方式');
    return inputBytes({ name: secret.name, mutable: secret.mutable, tool: secret.tool!, path: secret.path!, format: 'files', ...incoming });
  }
  async start(token: string, tool: ProxyTool, _alias: string | undefined, args: string[]): Promise<ToolInvocationSetup> {
    const identity = await this.authorize(token);
    const grants = (await this.repository.grants(identity.projectId)).filter(g => g.enabled && g.tool === tool);
    if (grants.length !== 1) throw new HttpError(403, grants.length ? '工具存在旧的多密钥配置，请重新选择一个密钥' : '项目未授权此工具连接');
    const grant = grants[0], checked = validateToolArgs(tool, args, grant);
    if (grant.files.length !== 1) throw new HttpError(403, '每种工具只能使用一个密钥，请重新配置');
    const setup: ToolInvocationSetup = { id: randomUUID(), tool, args: checked, files: [] };
    const snapshots = [];
    for (const binding of grant.files) {
      const secret = await this.requireSecret(binding.secretId);
      if (!secret.enabled) throw new HttpError(403, 'Secret 已停用');
      if (secret.tool && (secret.tool !== tool || secret.path !== binding.path)) throw new HttpError(403, '密钥所属工具或文件路径已变更');
      this.validateConfig({ ...secret, tool, path: binding.path });
      const bytes = this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext);
      setup.files.push({ path: binding.path, content: bytes.toString('base64'), secretId: secret.id, version: secret.version, mutable: secret.mutable,
        ...(secret.format === 'files' ? { format: 'files' as const } : {}) });
      snapshots.push({ path: binding.path, secretId: secret.id, version: secret.version, versionId: secret.currentVersionId,
        ...(secret.format === 'files' ? { format: 'files' as const } : {}) });
    }
    await this.repository.startInvocation({ id: setup.id, ...identity, grant, files: snapshots, createdAt: new Date().toISOString(), completedAt: null });
    return setup;
  }
  async complete(token: string, id: string, updates: Array<{ secretId: string; content: string }>, exitCode: number): Promise<ToolCompletionResult> {
    const identity = await this.authorize(token), invocation = await this.repository.invocation(id);
    if (!invocation || invocation.boxId !== identity.boxId || invocation.generation !== identity.generation || invocation.projectId !== identity.projectId) throw new HttpError(403, '工具调用不属于该 Sandbox');
    if (invocation.completedAt) return { saved: false };
    try {
      const grant = (await this.repository.grants(identity.projectId)).find(g => g.id === invocation.grant.id);
      if (!grant?.enabled || JSON.stringify(grant.files) !== JSON.stringify(invocation.grant.files)) throw new HttpError(403, '工具授权已撤销或变更');
      if (new Set(updates.map(update => update.secretId)).size !== updates.length) throw new HttpError(400, 'Secret 更新不可重复');
      const now = new Date().toISOString(), changes = [];
      for (const update of updates) {
        const snapshot = invocation.files.find(file => file.secretId === update.secretId);
        if (!snapshot) throw new HttpError(403, '不能更新未绑定的 Secret');
        const secret = await this.requireSecret(update.secretId);
        if (snapshot.format !== undefined && secret.format !== snapshot.format) throw new HttpError(409, '凭证格式已变更，请刷新运行环境后重试');
        if (!secret.enabled || !secret.mutable) throw new HttpError(403, 'Secret 不允许工具更新');
        this.validateConfig({ ...secret, tool: invocation.grant.tool, path: snapshot.path });
        if (secret.tool && (secret.tool !== invocation.grant.tool || secret.path !== snapshot.path)) throw new HttpError(403, '密钥所属工具或文件路径已变更');
        const raw = Buffer.from(update.content, 'base64');
        if (raw.toString('base64') !== update.content) throw new HttpError(400, 'Secret 更新编码无效');
        if (!Buffer.from(raw.toString('utf8')).equals(raw)) throw new HttpError(400, '认证文件必须使用 UTF-8 编码');
        if (secret.format === 'files' && secret.version !== snapshot.version) throw new HttpError(409, '文件组已更新，请刷新运行环境后重试');
        const bytes = this.updateBytes(secret, raw);
        const versionId = randomUUID(), ciphertext = this.crypto.seal(secret.id, versionId, bytes);
        changes.push({ secret, version: { id: versionId, secretId: secret.id, ciphertext, source: 'tool' as const, baseVersion: snapshot.version, createdAt: now, projectId: identity.projectId, invocationId: id, changes: ['content'] } });
      }
      const saved = await this.repository.completeInvocation({ ...invocation, completedAt: now }, changes, exitCode);
      const versions = changes.filter(({ secret }) => secret.format === 'files').map(({ secret, version }) => ({ secretId: secret.id, version: version.baseVersion! + 1 }));
      return { saved, ...(saved && versions.length ? { versions } : {}) };
    } catch (error) {
      const resources = await Promise.all(invocation.files.map(file => this.repository.get(file.secretId)));
      if (resources.every(Boolean)) throw error;
      // Acknowledge a deleted resource without accepting its refresh. Existing
      // runners then remove their private files instead of retaining tokens for
      // retry. Invocation identity was verified before entering this block.
      await this.repository.completeInvocation({ ...invocation, completedAt: new Date().toISOString() }, [], exitCode);
      return { saved: false, discarded: true };
    }
  }
}
