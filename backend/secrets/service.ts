import { larkCredential, type LarkCredential } from './lark-credential.js';
import { ToolRoles } from './roles.js';
import { mergedBinding, mergeNativeConfig, nativeConfigPath, nativeContextTool, nativeNames, type NativeSource } from './native-config.js';
import { authorizeCredential, describeTool, getTool, hasCredentials, registeredTools } from '../tool-access/index.js';
import type { ToolCatalogEntry } from '../../protocol/secret-types.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ProxyTool, SecretInput, SecretUpdate, SecretMetadata, SecretContent, SecretDeleteResult, ProvisionedToolFile } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import { SecretCrypto } from './crypto.js';
import { credentialPath, toolName, validateToolArgs } from './policy.js';
import type { SecretRepository, StoredSecret, StoredVersion } from './repository.js';
import { validateFileBundle } from '../../util/credential-files.mjs';
import { MountedToolHomes } from './mounted-home.js';
import type { ToolAuthorization } from '../../protocol/secret-types.js';
import type { DynamicTools } from '../tools/service.js';
import { isDynamicBuiltin } from '../tools/defaults.js';
import { ToolScripts } from '../tools/scripts.js';
import { ToolCredentialFiles } from '../tools/credentials.js';
import type { ToolCredentialRegistration } from '../../protocol/tool-credential-types.js';
import { join } from 'node:path';
import { TOOL_CREDENTIAL_IDENTITY } from '../../util/tool-runtime-identity.mjs';

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
    if (input.content !== undefined || input.files || input.supportFiles || input.directory || input.adapter || input.identity)
      throw new HttpError(400, '共享 HOME 凭据由 CLI 管理，不接受凭据内容');
    return Buffer.from('{}');
  }
  if (input.format !== 'text') throw new HttpError(400, '只支持原生文本认证文件');
  if (input.files || input.directory || input.adapter || input.identity || input.content === undefined) throw new HttpError(400, '单文件请提供 content');
  const bytes = secretBytes('text', input.content);
  return input.supportFiles ? Buffer.from(JSON.stringify(larkCredential(input.tool, input.path, input.content, input.supportFiles, input.supportVersion))) : bytes;
}
export class SecretService {
  homes?: MountedToolHomes;
  credentialFiles?: ToolCredentialFiles;
  readonly roles: ToolRoles;
  readonly scripts: ToolScripts;
  constructor(readonly repository: SecretRepository, private crypto: SecretCrypto, readonly tools?: DynamicTools) {
    this.roles = new ToolRoles(repository, () => this.toolCatalog(), tools ? action => tools.coordinate(action) : undefined);
    this.scripts = new ToolScripts(tools?.repository.scripts, tools ? action => tools.coordinate(action) : undefined);
  }
  private nativeSource(secret: StoredSecret): NativeSource {
    return { id: secret.id, name: secret.name, version: secret.version, content: this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8') };
  }
  private profiles(secret: StoredSecret) {
    return secret.format === 'text' && nativeContextTool(secret.tool!) ? nativeNames(secret.tool!, this.nativeSource(secret)) : undefined;
  }
  private validateSelected(secrets: StoredSecret[]) {
    for (const tool of registeredTools().filter(hasCredentials)) {
      const sources = secrets.filter(secret => secret.enabled && secret.tool === tool.name && secret.format === 'text').map(secret => this.nativeSource(secret));
      if (sources.length) mergeNativeConfig(tool.name, sources);
    }
  }
  private validateShared(secrets: StoredSecret[]) {
    this.validateSelected(secrets);
    const paths: string[] = secrets.filter(secret => nativeContextTool(secret.tool ?? '') && secret.enabled && secret.format === 'text')
      .map(secret => nativeConfigPath(secret.tool!));
    const nativePaths = [...new Set(paths)];
    const enabledTools = new Set<string>();
    // Disabled registrations still own their canonical files: reusing their path
    // would overwrite the retained credential rather than create another source.
    for (const secret of secrets) {
      if (!secret.tool || !secret.path || nativeContextTool(secret.tool) || !['text', 'lark', 'home'].includes(secret.format)) continue;
      if (secret.enabled) {
        if (enabledTools.has(secret.tool)) throw new HttpError(400, `${secret.tool} 共用一份主配置，请先停用已有配置`);
        enabledTools.add(secret.tool);
      }
      nativePaths.push(credentialPath(secret.path));
      if (secret.format === 'lark') nativePaths.push(...this.lark(secret).supportFiles.map(file => credentialPath(file.path)));
    }
    for (let i = 0; i < nativePaths.length; i++) for (let j = i + 1; j < nativePaths.length; j++) {
      const a = nativePaths[i], b = nativePaths[j];
      if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) throw new HttpError(400, '共享 HOME 中的凭据路径冲突');
    }
  }
  async init() {
    await this.repository.init();
    await this.repository.roles.bootstrap();
    await this.refreshHome();
  }
  async mountHomes(root: string) {
    this.homes = new MountedToolHomes(root); await this.homes.init();
    this.scripts.configureCache(join(root, 'tools/npm-cache'));
    this.credentialFiles = new ToolCredentialFiles(root, name => this.credentialConfiguration(name),
      action => this.tools ? this.tools.coordinate(action) : action(), paths => this.homes!.preserve(paths));
  }
  publishHome() {
    if (!this.homes) throw new Error('Mounted debug HOME is not configured');
    const publish = () => this.homes!.publish(() => this.provision());
    return this.tools ? this.tools.coordinate(publish) : publish();
  }
  private async credentialConfiguration(name: string) {
    toolName(name);
    const definition = await this.tools?.get(name), secrets = (await this.repository.list()).filter(secret => secret.tool === name);
    const adapter = getTool(name);
    if (!definition && !registeredTools().some(tool => tool.name === name) && !secrets.length) throw new HttpError(404, '工具不存在');
    const registrations: ToolCredentialRegistration[] = secrets.map(secret => {
      const files = hasCredentials(adapter) ? [adapter.configPath] : secret.format === 'lark'
        ? [secret.path!, ...this.lark(secret).supportFiles.map(file => file.path)]
        : secret.format === 'files' ? this.bundle(secret).files.map(file => file.path) : secret.path ? [secret.path] : [];
      return { id: secret.id, name: secret.name, path: secret.path, enabled: secret.enabled, format: secret.format, version: secret.version, files };
    });
    const paths = definition?.credentialPaths?.length ? definition.credentialPaths
      : hasCredentials(adapter) ? [adapter.configPath] : [...registrations.flatMap(item => item.files), ...(definition?.credentialPath ? [definition.credentialPath] : [])];
    const unique = [...new Set(paths.map(credentialPath))];
    const roots = unique.filter(path => !unique.some(parent => parent !== path && path.startsWith(parent + '/'))).sort();
    const [load, save] = await Promise.all([definition?.credentialParseScriptId ? this.scripts.get(definition.credentialParseScriptId) : undefined,
      definition?.credentialSaveScriptId ? this.scripts.get(definition.credentialSaveScriptId) : undefined]);
    const primaryPath = hasCredentials(adapter) ? adapter.configPath
      : secrets.find(secret => secret.enabled && ['text', 'lark', 'home'].includes(secret.format))?.path ?? definition?.credentialPath;
    const source = name === 'meegle' ? secrets.filter(secret => secret.format === 'files').map(secret => this.bundle(secret)).find(bundle => bundle.adapter === 'meegle')?.identity : undefined;
    const targetIdentity = name === 'meegle' ? { ...TOOL_CREDENTIAL_IDENTITY,
      username: (definition?.env.USER ?? TOOL_CREDENTIAL_IDENTITY.username).replaceAll('${HOME}', '/home/debug').replaceAll('${CREDENTIAL}', primaryPath ? `/home/debug/${primaryPath}` : '') || TOOL_CREDENTIAL_IDENTITY.username } : undefined;
    const context = { tool: name, ...(primaryPath ? { primaryPath } : {}),
      ...(targetIdentity ? { identity: source ?? targetIdentity, targetIdentity } : {}) };
    const excludedPaths = name === 'meegle' ? ['.meegle/cache'] : [];
    const revision = JSON.stringify([definition?.version ?? 0, roots, excludedPaths, registrations.map(item => [item.id, item.version, item.path]), context, load?.id, load?.version, save?.id, save?.version]);
    const validate = (path: string, bytes: Buffer) => {
      if (!hasCredentials(adapter) || path !== adapter.configPath) return;
      try { adapter.listCredentials([], bytes); }
      catch { throw new HttpError(400, '保存结果不是有效的原生凭据配置'); }
    };
    return { roots, excludedPaths, registrations, context, load, save, validate, scriptVersion: parseInt(createHash('sha256').update(revision).digest('hex').slice(0, 12), 16) };
  }
  private async refreshHome() {
    if (this.homes) await this.publishHome();
  }

  private metadata(secret: StoredSecret, projectIds: string[] = []): SecretMetadata {
    const { ciphertext: _ciphertext, currentVersionId: _versionId, alias: _alias, nativeHome: _nativeHome, format, ...metadata } = secret;
    const bundle = format === 'files' ? this.bundle(secret) : null;
    const native = format === 'lark' ? this.lark(secret) : null;
    const nativeNames = this.profiles(secret);
    return { ...metadata, storage: secret.nativeHome ? 'native' : 'database',
      homeDirectory: '/home/debug',
      ...(nativeNames ? { nativeNames } : {}), ...(native ? { supportFilePaths: native.supportFiles.map(file => file.path) } : {}), format: format === 'files' ? 'files' : format === 'home' ? 'home' : 'text', requiresTextImport: !['text', 'lark', 'home'].includes(format), projectIds,
      ...(bundle ? { filePaths: bundle.files.map(file => file.path), directory: bundle.directory, adapter: bundle.adapter, identity: bundle.identity } : {}) };
  }
  private lark(secret: StoredSecret): LarkCredential {
    let payload;
    try { payload = JSON.parse(this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8')); } catch { throw new HttpError(400, 'Lark 凭证格式无效'); }
    // Imported bundles must be complete; a CLI-managed HOME reflects whatever
    // files currently exist. The native CLI reports a missing login when used.
    if (secret.nativeHome) return payload;
    return larkCredential(secret.tool!, secret.path!, payload.content, payload.supportFiles, payload.supportVersion);
  }
  private bundle(secret: StoredSecret) { return fileBundle(JSON.parse(this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('utf8'))); }
  async list() {
    const [secrets, catalog, assignments] = await Promise.all([this.repository.list(), this.roles.catalog(), this.repository.roles.assignments()]);
    return secrets.map(secret => {
      const names = this.profiles(secret);
      const roles = new Set(catalog.roles.filter(role => role.permissions.some(permission => permission.tool === secret.tool && permission.enabled &&
        (!names || names.some(name => permission.credentials?.includes(name))))).map(role => role.id));
      return this.metadata(secret, assignments.filter(item => item.roleId && roles.has(item.roleId)).map(item => item.projectId));
    });
  }
  async toolCatalog(): Promise<ToolCatalogEntry[]> {
    const secrets = await this.repository.list();
    const dynamic = await this.tools?.list() ?? [];
    const names = new Set([...registeredTools().filter(tool => !this.tools || !isDynamicBuiltin(tool.name)).map(tool => tool.name), ...dynamic.map(tool => tool.name),
      ...(this.tools ? [] : secrets.flatMap(secret => secret.tool ? [secret.tool] : []))]);
    return Promise.all([...names].map(async name => {
      const adapter = getTool(name);
      const config = hasCredentials(adapter) ? await this.homes?.read(adapter.configPath) : undefined;
      const descriptor = describeTool(adapter, secrets.filter(secret => secret.enabled && secret.tool === name && secret.format === 'text').map(secret => this.nativeSource(secret)), config);
      if (this.homes && config === undefined && descriptor.kind === 'tool-with-credential') delete descriptor.defaultCredential;
      return descriptor;
    }));
  }
  private validateConfig(secret: StoredSecret) {
    if (!['text', 'lark', 'home'].includes(secret.format)) throw new HttpError(400, '每份凭证只支持原生文本文件或共享 HOME，请重新导入');
    if (!secret.tool || !secret.path) throw new HttpError(400, '请填写工具名和认证文件路径');
    toolName(secret.tool);
    credentialPath(secret.path);
    if (secret.format === 'lark') this.lark(secret);
    if (secret.format === 'home') {
      if (nativeContextTool(secret.tool!)) throw new HttpError(400, '此工具请使用原生连接配置');
    }
    this.profiles(secret);
  }

  private async requireSecret(id: string) { const secret = await this.repository.get(id); if (!secret) throw new HttpError(404, 'Secret 不存在'); return secret; }
  async content(id: string): Promise<SecretContent> {
    const secret = await this.requireSecret(id), bytes = this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext);
    if (secret.format === 'home') return { format: 'home', content: '', requiresTextImport: false, version: secret.version };
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
    this.validateShared([...(await this.repository.list()), secret]);
    await this.repository.save(secret, { id: versionId, secretId: id, ciphertext, source: 'operator', baseVersion: null, createdAt: now, projectId: null, invocationId: null, changes: ['created'] });
    await this.refreshHome();
    return this.metadata(await this.requireSecret(id));
  }
  async update(id: string, input: SecretUpdate) {
    const secret = await this.requireSecret(id), now = new Date().toISOString();
    const contentChanged = input.content !== undefined || input.files !== undefined || input.supportFiles !== undefined || (input.format === 'home' && secret.format !== 'home');
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
    this.validateShared([...(await this.repository.list()).filter(secret => secret.id !== id), candidate]);
    const version: StoredVersion = { id: versionId, secretId: id, ciphertext, source: 'operator', baseVersion: secret.version, createdAt: now, projectId: null, invocationId: null, changes };
    const { content: _content, ...stored } = next as StoredSecret & { content?: string };
    await this.repository.save(stored, version);
    await this.refreshHome();
    return this.metadata(await this.requireSecret(id));
  }
  async versions(id: string) { await this.requireSecret(id); return (await this.repository.versions(id)).map(({ ciphertext: _ciphertext, secretId: _id, ...metadata }) => metadata); }
  async delete(id: string): Promise<SecretDeleteResult> {
    await this.repository.delete(id); await this.refreshHome(); return { ok: true };
  }
  /** All debug processes share the enabled native connection catalog. */
  async provision(): Promise<ProvisionedToolFile[]> {
    const secrets = await this.repository.list();
    this.validateShared(secrets);
    const files: ProvisionedToolFile[] = [];
    const nativeSources = new Map<string, NativeSource[]>();
    for (const secret of secrets) {
      if (!secret.enabled || !secret.tool || !secret.path || !['text', 'lark', 'home'].includes(secret.format)) continue;
      toolName(secret.tool); credentialPath(secret.path);
      if (nativeContextTool(secret.tool)) {
        const sources = nativeSources.get(secret.tool) ?? []; sources.push(this.nativeSource(secret)); nativeSources.set(secret.tool, sources); continue;
      }
      if (secret.format === 'home' || secret.nativeHome) {
        files.push({ tool: secret.tool, secretId: secret.id, path: secret.path, content: '', mutable: true, version: secret.version, alias: secret.alias ?? 'default', externallyManaged: true });
        continue;
      }
      const native = secret.format === 'lark' ? this.lark(secret) : null;
      const content = native ? Buffer.from(native.content).toString('base64') : this.crypto.open(secret.id, secret.currentVersionId, secret.ciphertext).toString('base64');
      files.push({ tool: secret.tool, secretId: secret.id, path: secret.path, content, mutable: secret.mutable, version: secret.version,
        alias: secret.alias ?? 'default' });
      for (const file of native?.supportFiles ?? []) files.push({ tool: secret.tool, secretId: secret.id, path: file.path, content: file.content, mutable: secret.mutable, version: native!.supportVersion, alias: secret.alias ?? 'default' });
    }
    for (const [tool, sources] of nativeSources) {
      files.push(await this.homes?.externallyManaged(nativeConfigPath(tool))
        ? { ...mergedBinding(tool, sources), content: '', mutable: true, alias: '', externallyManaged: true }
        : mergeNativeConfig(tool, sources));
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
    const definition = await this.tools?.get(tool);
    if (definition && !definition.enabled) throw new HttpError(403, '此工具已停用');
    if (this.tools && !definition && (isDynamicBuiltin(tool) || !registeredTools().some(registered => registered.name === tool)))
      throw new HttpError(404, '工具未注册或已删除');
    const adapter = getTool(tool);
    const permission = (await this.roles.state(identity.projectId)).permissions.find(permission => permission.tool === tool);
    adapter.authorize(permission);
    const checked = validateToolArgs(tool, args);
    const allowed = hasCredentials(adapter) ? authorizeCredential(adapter, permission!, checked) : checked;
    await this.scripts.checkPermission(definition, { tool, args: allowed, boxId, projectId: identity.projectId, permission: permission! });
    const execution = definition ? await this.tools!.execution(definition) : undefined;
    const credentialRoots = (path: string | undefined) => execution
      ? { credentialPaths: definition?.credentialPaths?.length ? definition.credentialPaths : path ? [path] : [] } : {};
    if (hasCredentials(adapter)) {
      return { tool, args: allowed, home: '/home/debug', path: adapter.configPath, ...(execution ? { execution } : {}), ...credentialRoots(adapter.configPath) };
    }
    // Generic tools own their authentication. Even help/login must work before
    // native credential files exist; only a configured path override is needed.
    const configs = (await this.repository.toolConfigs(tool)).filter(config => config.enabled && ['text', 'lark', 'home'].includes(config.format));
    if (configs.length > 1) throw new HttpError(409, '此工具有多份已启用的共享主配置');
    const path = configs[0]?.path ?? definition?.credentialPath;
    if (!path && execution && Object.values(execution.env).some(value => value.includes('${CREDENTIAL}')))
      throw new HttpError(409, '请先配置认证文件路径或添加工具 Secret');
    return { tool, args: checked, home: '/home/debug', ...(path ? { path: credentialPath(path) } : {}), ...(execution ? { execution } : {}), ...credentialRoots(path ?? undefined) };
  }
}
