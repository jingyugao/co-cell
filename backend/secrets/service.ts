import { randomUUID } from 'node:crypto';
import type { ProjectToolGrant, ProjectToolGrantInput, ProjectToolSelection, ProxyTool, SecretInput, SecretUpdate, SecretMetadata, SecretDeleteResult, ToolInvocationSetup, ToolCompletionResult } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import { SecretCrypto } from './crypto.js';
import { credentialPath, toolName, validateToolArgs } from './policy.js';
import type { SecretRepository, StoredSecret, StoredVersion } from './repository.js';

export const MAX_SECRET_BYTES = 64 * 1024;
export function secretBytes(format: SecretInput['format'], content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  if (format !== 'text' || !bytes.length || bytes.length > MAX_SECRET_BYTES || bytes.toString('utf8') !== content)
    throw new HttpError(400, 'Secret 必须为 1..65536 字节的 UTF-8 文本');
  return bytes;
}
export class SecretService {
  constructor(readonly repository: SecretRepository, private crypto: SecretCrypto,
    private liveRuntime: (boxId: string) => Promise<{ generation: number; phase: string }>,
    private ownsRuntime: (projectId: string, boxId: string) => boolean) {}
  async init() { await this.repository.init(); }
  private metadata(secret: StoredSecret, projectIds: string[] = []): SecretMetadata {
    const { ciphertext: _ciphertext, currentVersionId: _versionId, alias: _alias, format, ...metadata } = secret;
    return { ...metadata, format: 'text', requiresTextImport: format !== 'text', projectIds };
  }
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
    if (secret.format !== 'text') throw new HttpError(409, '旧格式密钥需要重新导入原始文本文件');
    if (!secret.tool || !secret.path) throw new HttpError(400, '请填写工具名和认证文件路径');
    toolName(secret.tool);
    credentialPath(secret.path);
  }
  private async requireSecret(id: string) { const secret = await this.repository.get(id); if (!secret) throw new HttpError(404, 'Secret 不存在'); return secret; }
  async content(id: string) {
    const secret = await this.requireSecret(id), bytes = this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext);
    return { format: 'text' as const, content: secret.format === 'binary' ? '' : bytes.toString('utf8'), requiresTextImport: secret.format !== 'text', version: secret.version };
  }
  async create(input: SecretInput) {
    const id = randomUUID(), versionId = randomUUID(), now = new Date().toISOString();
    const bytes = secretBytes(input.format, input.content), ciphertext = this.crypto.seal(id, versionId, bytes);
    const secret: StoredSecret = { id, name: input.name, format: input.format, mutable: input.mutable, enabled: true, version: 0, currentVersionId: versionId, ciphertext, createdAt: now, updatedAt: now,
      tool: input.tool, path: input.path, alias: 'default' };
    this.validateConfig(secret);
    await this.repository.save(secret, { id: versionId, secretId: id, ciphertext, source: 'operator', baseVersion: null, createdAt: now, projectId: null, invocationId: null, changes: ['created'] });
    return this.metadata(await this.requireSecret(id));
  }
  async update(id: string, input: SecretUpdate) {
    const secret = await this.requireSecret(id), now = new Date().toISOString();
    const next: StoredSecret = { ...secret, ...input, alias: secret.alias ?? 'default', format: input.content === undefined ? secret.format : 'text', updatedAt: now };
    const changes = Object.keys(input).filter(key => key === 'content' || input[key as keyof typeof input] !== secret[key as keyof StoredSecret]);
    if (!changes.length) return this.metadata(secret);
    const bytes = input.content === undefined ? this.crypto.open(id, secret.currentVersionId, secret.ciphertext) : secretBytes('text', input.content);
    if (changes.some(key => ['tool', 'path', 'content'].includes(key))) this.validateConfig(next);
    if (changes.some(key => ['tool', 'path'].includes(key))) {
      const incompatible = (await this.repository.allGrants()).some(grant => grant.files.some(file => file.secretId === id
        && (grant.tool !== next.tool || file.path !== next.path)));
      if (incompatible) throw new HttpError(400, '密钥已被项目使用，不能更改工具或认证文件配置');
    }
    const versionId = randomUUID(), ciphertext = this.crypto.seal(id, versionId, bytes);
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
  async registerRuntime(boxId: string, projectId: string, generation: number) {
    await this.repository.registerRuntime(boxId, projectId, generation);
    return this.crypto.runtimeToken(boxId, generation);
  }
  private async authorize(token: string) {
    const identity = this.crypto.verifyRuntimeToken(token);
    if (!identity) throw new HttpError(401, '工具认证无效');
    const runtime = await this.repository.runtime(identity.boxId);
    if (!runtime || runtime.generation !== identity.generation || !this.ownsRuntime(runtime.projectId, identity.boxId)) throw new HttpError(403, 'Sandbox 未绑定当前项目');
    const live = await this.liveRuntime(identity.boxId);
    if (live.generation !== identity.generation || live.phase !== 'running') throw new HttpError(403, 'Sandbox 运行身份已失效');
    return { ...identity, projectId: runtime.projectId };
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
      setup.files.push({ path: binding.path, content: bytes.toString('base64'), secretId: secret.id, version: secret.version, mutable: secret.mutable });
      snapshots.push({ path: binding.path, secretId: secret.id, version: secret.version, versionId: secret.currentVersionId });
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
        if (!secret.enabled || !secret.mutable) throw new HttpError(403, 'Secret 不允许工具更新');
        this.validateConfig({ ...secret, tool: invocation.grant.tool, path: snapshot.path });
        if (secret.tool && (secret.tool !== invocation.grant.tool || secret.path !== snapshot.path)) throw new HttpError(403, '密钥所属工具或文件路径已变更');
        const raw = Buffer.from(update.content, 'base64');
        if (raw.toString('base64') !== update.content) throw new HttpError(400, 'Secret 更新编码无效');
        if (!Buffer.from(raw.toString('utf8')).equals(raw)) throw new HttpError(400, '认证文件必须使用 UTF-8 编码');
        const bytes = secretBytes('text', raw.toString('utf8'));
        const versionId = randomUUID(), ciphertext = this.crypto.seal(secret.id, versionId, bytes);
        changes.push({ secret, version: { id: versionId, secretId: secret.id, ciphertext, source: 'tool' as const, baseVersion: snapshot.version, createdAt: now, projectId: identity.projectId, invocationId: id, changes: ['content'] } });
      }
      return { saved: await this.repository.completeInvocation({ ...invocation, completedAt: now }, changes, exitCode) };
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
