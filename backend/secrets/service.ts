import { randomUUID } from 'node:crypto';
import { PROXY_TOOLS, type ProjectToolGrant, type ProjectToolGrantInput, type ProjectToolSelection, type ProxyTool, type SecretInput, type SecretUpdate, type SecretMetadata, type ToolInvocationSetup } from '../../protocol/secret-types.js';
import { defaultCredentialPath } from '../../util/tool-secrets.js';
import { HttpError } from '../../util/errors.js';
import { SecretCrypto } from './crypto.js';
import { credentialPath, validateToolArgs } from './policy.js';
import type { SecretRepository, StoredSecret, StoredVersion } from './repository.js';

export const MAX_SECRET_BYTES = 64 * 1024;
export function secretBytes(format: SecretInput['format'], content: string): Buffer {
  const bytes = Buffer.from(content, format === 'binary' ? 'base64' : 'utf8');
  if (!bytes.length || bytes.length > MAX_SECRET_BYTES || (format === 'binary' && bytes.toString('base64') !== content))
    throw new HttpError(400, 'Secret 必须为 1..65536 字节；二进制内容使用标准 base64');
  if (format === 'json') {
    try { const value = JSON.parse(content); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); }
    catch { throw new HttpError(400, 'Secret 内容必须是 JSON 对象'); }
  }
  return bytes;
}
export class SecretService {
  constructor(readonly repository: SecretRepository, private crypto: SecretCrypto,
    private liveRuntime: (boxId: string) => Promise<{ generation: number; phase: string }>,
    private ownsRuntime: (projectId: string, boxId: string) => boolean) {}
  async init() { await this.repository.init(); }
  private metadata(secret: StoredSecret, projectIds: string[] = []): SecretMetadata {
    const { ciphertext: _ciphertext, currentVersionId: _versionId, ...metadata } = secret;
    return { ...metadata, projectIds };
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
  private validateConfig(secret: StoredSecret, bytes: Buffer) {
    if (!secret.tool) {
      if (secret.path || secret.alias) throw new HttpError(400, '请先选择密钥所属工具');
      return;
    }
    if (!PROXY_TOOLS.includes(secret.tool)) throw new HttpError(400, '工具类型无效');
    const path = credentialPath(secret.path ?? '');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(secret.alias ?? '')) throw new HttpError(400, '连接名称无效');
    const supported = secret.tool === 'mysql' ? ['.mylogin.cnf', '.my.cnf'].includes(path)
      : secret.tool === 'kubectl' ? path === '.kube/config'
      : secret.tool === 'glab' ? path.startsWith('.config/glab-cli/')
      : secret.tool === 'meegle' ? path.startsWith('.meegle/')
      : /^(?:\.lark-cli\/|\.config\/lark-cli\/|\.local\/share\/lark-cli\/)/.test(path);
    if (!supported || (secret.tool === 'kubectl' && secret.format !== 'json')) throw new HttpError(400, '认证文件类型或路径与工具不匹配');
    if (secret.tool === 'mysql' && ((path === '.mylogin.cnf' && secret.format !== 'binary') || (path === '.my.cnf' && secret.format === 'binary')))
      throw new HttpError(400, 'MySQL 登录文件使用 binary，.my.cnf 使用 JSON 或文本');
    if (['mysql', 'kubectl'].includes(secret.tool) && secret.mutable) throw new HttpError(400, 'MySQL 和 Kubernetes 配置由管理员维护');
    materialize(secret.tool, path, secret.alias!, secret, bytes);
  }
  private async requireSecret(id: string) { const secret = await this.repository.get(id); if (!secret) throw new HttpError(404, 'Secret 不存在'); return secret; }
  async content(id: string) {
    const secret = await this.requireSecret(id), bytes = this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext);
    return { format: secret.format, content: bytes.toString(secret.format === 'binary' ? 'base64' : 'utf8'), version: secret.version };
  }
  async create(input: SecretInput) {
    const id = randomUUID(), versionId = randomUUID(), now = new Date().toISOString();
    const bytes = secretBytes(input.format, input.content), ciphertext = this.crypto.seal(id, versionId, bytes);
    const secret: StoredSecret = { id, name: input.name, format: input.format, mutable: input.mutable, enabled: true, version: 0, currentVersionId: versionId, ciphertext, createdAt: now, updatedAt: now,
      tool: input.tool ?? null, path: input.path ?? (input.tool ? defaultCredentialPath(input.tool, input.format) : null), alias: input.alias ?? (input.tool ? 'default' : null) };
    this.validateConfig(secret, bytes);
    await this.repository.save(secret, { id: versionId, secretId: id, ciphertext, source: 'operator', baseVersion: null, createdAt: now, projectId: null, invocationId: null, changes: ['created'] });
    return this.metadata(await this.requireSecret(id));
  }
  async update(id: string, input: SecretUpdate) {
    const secret = await this.requireSecret(id), now = new Date().toISOString();
    const next: StoredSecret = { ...secret, ...input,
      path: input.path ?? (input.tool && input.tool !== secret.tool ? defaultCredentialPath(input.tool, secret.format) : secret.path),
      alias: input.alias ?? (input.tool && !secret.alias ? 'default' : secret.alias), updatedAt: now };
    const changes = Object.keys(input).filter(key => key === 'content' || input[key as keyof typeof input] !== secret[key as keyof StoredSecret]);
    if (!changes.length) return this.metadata(secret);
    const bytes = input.content === undefined ? this.crypto.open(id, secret.currentVersionId, secret.ciphertext) : secretBytes(secret.format, input.content);
    this.validateConfig(next, bytes);
    if (changes.some(key => ['tool', 'path', 'alias'].includes(key))) {
      const incompatible = (await this.repository.allGrants()).some(grant => grant.files.some(file => file.secretId === id
        && (grant.tool !== next.tool || file.path !== next.path || grant.alias !== next.alias)));
      if (incompatible) throw new HttpError(400, '密钥已被项目使用，不能更改工具或认证文件配置');
    }
    const versionId = randomUUID(), ciphertext = this.crypto.seal(id, versionId, bytes);
    const version: StoredVersion = { id: versionId, secretId: id, ciphertext, source: 'operator', baseVersion: secret.version, createdAt: now, projectId: null, invocationId: null, changes };
    const { content: _content, ...stored } = next as StoredSecret & { content?: string };
    await this.repository.save(stored, version);
    return this.metadata(await this.requireSecret(id));
  }
  async versions(id: string) { await this.requireSecret(id); return (await this.repository.versions(id)).map(({ ciphertext: _ciphertext, secretId: _id, ...metadata }) => metadata); }
  grants(projectId: string) { return this.repository.grants(projectId); }
  async saveGrant(projectId: string, input: ProjectToolGrantInput) {
    if (input.files.length !== 1) throw new HttpError(400, '每种工具只能选择一个密钥');
    const file = input.files[0], path = credentialPath(file.path), secret = await this.requireSecret(file.secretId);
    if (secret.tool && (secret.tool !== input.tool || secret.path !== path || secret.alias !== input.alias)) throw new HttpError(400, '密钥所属工具或连接配置不匹配');
    this.validateConfig({ ...secret, tool: input.tool, path, alias: input.alias }, this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext));
    const existing = (await this.repository.grants(projectId)).find(g => g.tool === input.tool && g.alias === input.alias);
    const { policy: _legacy, ...binding } = input;
    const grant = { ...binding, id: existing?.id ?? randomUUID(), projectId, updatedAt: new Date().toISOString() };
    await this.repository.saveGrant(grant);
    return (await this.repository.grants(projectId)).find(value => value.tool === input.tool && value.alias === input.alias)!;
  }
  async saveSelections(projectId: string, selections: ProjectToolSelection[]) {
    if (selections.length !== PROXY_TOOLS.length || new Set(selections.map(value => value.tool)).size !== PROXY_TOOLS.length
      || selections.some(value => !PROXY_TOOLS.includes(value.tool))) throw new HttpError(400, '每种工具必须且只能配置一次');
    const [current, all] = await Promise.all([this.repository.grants(projectId), this.repository.allGrants()]);
    const grants: ProjectToolGrant[] = [];
    for (const { tool, secretId } of selections) {
      if (!secretId) continue;
      const secret = this.withLegacyConfig(await this.requireSecret(secretId), all);
      if (!secret.enabled || secret.tool !== tool) throw new HttpError(400, '请选择该工具已启用的密钥');
      this.validateConfig(secret, this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext));
      const files = [{ secretId, path: secret.path! }];
      const previous = current.find(grant => grant.tool === tool && grant.alias === secret.alias && JSON.stringify(grant.files) === JSON.stringify(files));
      grants.push({ id: previous?.id ?? randomUUID(), projectId, tool, alias: secret.alias!, files, enabled: true, updatedAt: new Date().toISOString() });
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
  async start(token: string, tool: ProxyTool, alias: string | undefined, args: string[]): Promise<ToolInvocationSetup> {
    const identity = await this.authorize(token);
    const grants = (await this.repository.grants(identity.projectId)).filter(g => g.enabled && g.tool === tool);
    if (grants.length !== 1) throw new HttpError(403, grants.length ? '工具存在旧的多密钥配置，请重新选择一个密钥' : '项目未授权此工具连接');
    const grant = grants[0], checked = validateToolArgs(tool, args, grant);
    if (alias && alias !== grant.alias) throw new HttpError(403, '连接别名与项目所选密钥不匹配');
    if (grant.files.length !== 1) throw new HttpError(403, '每种工具只能使用一个密钥，请重新配置');
    const setup: ToolInvocationSetup = { id: randomUUID(), tool, args: checked, files: [] };
    const snapshots = [];
    for (const binding of grant.files) {
      const secret = await this.requireSecret(binding.secretId);
      if (!secret.enabled) throw new HttpError(403, 'Secret 已停用');
      const bytes = this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext);
      const rendered = materialize(tool, binding.path, grant.alias, secret, bytes);
      setup.files.push({ path: binding.path, content: rendered.toString('base64'), secretId: secret.id, version: secret.version, mutable: secret.mutable });
      snapshots.push({ path: binding.path, secretId: secret.id, version: secret.version, versionId: secret.currentVersionId });
    }
    await this.repository.startInvocation({ id: setup.id, ...identity, grant, files: snapshots, createdAt: new Date().toISOString(), completedAt: null });
    return setup;
  }
  async complete(token: string, id: string, updates: Array<{ secretId: string; content: string }>, exitCode: number) {
    const identity = await this.authorize(token), invocation = await this.repository.invocation(id);
    if (!invocation || invocation.boxId !== identity.boxId || invocation.generation !== identity.generation || invocation.projectId !== identity.projectId) throw new HttpError(403, '工具调用不属于该 Sandbox');
    if (invocation.completedAt) return { saved: false };
    const grant = (await this.repository.grants(identity.projectId)).find(g => g.id === invocation.grant.id);
    if (!grant?.enabled || JSON.stringify(grant.files) !== JSON.stringify(invocation.grant.files)) throw new HttpError(403, '工具授权已撤销或变更');
    if (new Set(updates.map(update => update.secretId)).size !== updates.length) throw new HttpError(400, 'Secret 更新不可重复');
    const now = new Date().toISOString(), changes = [];
    for (const update of updates) {
      const snapshot = invocation.files.find(file => file.secretId === update.secretId);
      if (!snapshot) throw new HttpError(403, '不能更新未绑定的 Secret');
      const secret = await this.requireSecret(update.secretId);
      if (!secret.enabled || !secret.mutable) throw new HttpError(403, 'Secret 不允许工具更新');
      if (invocation.grant.tool === 'mysql' || invocation.grant.tool === 'kubectl') throw new HttpError(403, '该工具认证配置不支持自动回写');
      const raw = Buffer.from(update.content, 'base64');
      if (raw.toString('base64') !== update.content) throw new HttpError(400, 'Secret 更新编码无效');
      if (secret.format !== 'binary' && !Buffer.from(raw.toString('utf8')).equals(raw)) throw new HttpError(400, '认证文件必须使用 UTF-8 编码');
      const bytes = secretBytes(secret.format, raw.toString(secret.format === 'binary' ? 'base64' : 'utf8'));
      const versionId = randomUUID(), ciphertext = this.crypto.seal(secret.id, versionId, bytes);
      changes.push({ secret, version: { id: versionId, secretId: secret.id, ciphertext, source: 'tool' as const, baseVersion: snapshot.version, createdAt: now, projectId: identity.projectId, invocationId: id, changes: ['content'] } });
    }
    return { saved: await this.repository.completeInvocation({ ...invocation, completedAt: now }, changes, exitCode) };
  }
}
function materialize(tool: ProxyTool, path: string, alias: string, secret: StoredSecret, bytes: Buffer): Buffer {
  if (tool === 'mysql' && path === '.my.cnf' && secret.format === 'json') {
    const config = JSON.parse(bytes.toString()), fields = ['host', 'user', 'password', 'port', 'database'];
    if (Object.keys(config).some(key => !fields.includes(key)) || !config.host || !config.user) throw new HttpError(400, 'MySQL JSON 支持 host、user、password、port、database');
    const lines = fields.filter(key => config[key] !== undefined).map(key => {
      const value = String(config[key]); if (/[\0\r\n]/.test(value)) throw new HttpError(400, 'MySQL 配置值无效');
      return `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    });
    return Buffer.from(`[client]\n${lines.join('\n')}\n`);
  }
  if (tool === 'kubectl') {
    const config = JSON.parse(bytes.toString());
    if (!Array.isArray(config.contexts) || config.contexts.length !== 1 || !Array.isArray(config.users) || !Array.isArray(config.clusters)) throw new HttpError(400, 'Kubeconfig JSON 必须包含一个 context');
    const context = config.contexts[0], cluster = config.clusters.find((c: any) => c.name === context.context?.cluster), user = config.users.find((u: any) => u.name === context.context?.user);
    if (!cluster || !user || Object.keys(cluster.cluster).some(key => !['server', 'certificate-authority-data', 'tls-server-name'].includes(key)) ||
        Object.keys(user.user).some(key => !['token', 'client-certificate-data', 'client-key-data'].includes(key))) throw new HttpError(400, 'Kubeconfig 仅支持内嵌认证；禁止 exec、插件和本地文件引用');
    let url: URL; try { url = new URL(cluster.cluster.server); } catch { throw new HttpError(400, 'Kubernetes 地址无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new HttpError(400, 'Kubernetes 必须使用 HTTPS');
    return Buffer.from(JSON.stringify({ apiVersion: 'v1', kind: 'Config', clusters: [cluster], users: [user], contexts: [{ name: alias, context: context.context }], 'current-context': alias }));
  }
  return bytes;
}
