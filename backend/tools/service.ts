import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DynamicToolCreateInput, DynamicToolExecution, DynamicToolInput } from '../../protocol/tool-types.js';
import { validateDynamicToolExecution } from '../../util/dynamic-tool-config.mjs';
import { HttpError } from '../../util/errors.js';
import { credentialPath, toolName } from '../secrets/policy.js';
import type { SharedCoordinator } from '../infra/storage/coordination.js';
import type { ToolRepository } from './repository.js';
import { ToolPackages, toolDirectory } from './packages.js';

export class DynamicTools {
  readonly packages: ToolPackages;
  private readonly root: string;
  private pending = Promise.resolve();
  constructor(readonly repository: ToolRepository, sharedRoot: string, private coordinator?: SharedCoordinator) {
    this.packages = new ToolPackages(sharedRoot);
    this.root = join(sharedRoot, 'tools');
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = () => this.coordinator ? this.coordinator.run('cocell-tool-definitions', action) : action();
    const current = this.pending.then(run);
    this.pending = current.then(() => {}, () => {});
    return current;
  }
  /** Serialize grant validation with definition deletion across API instances. */
  coordinate<T>(action: () => Promise<T>) { return this.serial(action); }
  async init() {
    await this.repository.init();
    await this.packages.init();
    await this.serial(() => this.publish());
  }
  list() { return this.repository.list(); }
  get(name: string) { return this.repository.get(toolName(name)); }
  create(input: DynamicToolCreateInput) {
    const definition: DynamicToolInput = {
      ...input, name: input.name, description: input.description ?? '', instructions: input.instructions ?? '',
      enabled: input.enabled ?? true, executable: input.executable ?? input.name,
      args: input.args ?? [], env: input.env ?? {}, timeoutMs: input.timeoutMs ?? 20000,
    };
    return this.save(definition);
  }
  private async validate(input: DynamicToolInput) {
    toolName(input.name);
    if (['cocell', 'help', 'list', 'cellbox-container-agent'].includes(input.name))
      throw new HttpError(400, '此名称由内置工具保留，请使用其他工具名');
    if (input.credentialPath) credentialPath(input.credentialPath);
    if (input.credentialMode !== undefined && !['shared', 'named'].includes(input.credentialMode))
      throw new HttpError(400, '凭据模式无效');
    if (input.credentialMode === 'named') {
      if (!input.credentialPath || !input.credentialParseScriptId || !input.permissionScriptId)
        throw new HttpError(400, '多凭据模式需要主配置路径、Load hook 和权限脚本');
      if (!this.repository.scripts) throw new HttpError(503, '脚本目录尚未初始化');
    }
    const roots = input.credentialPaths ?? [];
    if (roots.length > 16) throw new HttpError(400, '认证文件根目录最多支持 16 个');
    const checkedRoots = roots.map(credentialPath);
    const excluded = input.credentialExcludedPaths ?? [];
    if (excluded.length > 16) throw new HttpError(400, '凭据排除路径最多支持 16 个');
    for (const path of excluded) {
      credentialPath(path);
      if (!checkedRoots.some(root => path === root || path.startsWith(root + '/')))
        throw new HttpError(400, '排除路径必须位于凭据目录内');
      if (input.credentialPath && (path === input.credentialPath || input.credentialPath.startsWith(path + '/')))
        throw new HttpError(400, '不能排除主凭据文件');
    }
    for (const identity of Object.values(input.credentialContext ?? {})) {
      if (!identity || ['hostname', 'username'].some(key => {
        const value = identity[key as keyof typeof identity];
        return typeof value !== 'string' || !value || value.length > 253 || /[\u0000-\u001f\u007f]/.test(value);
      })) throw new HttpError(400, '凭据身份上下文无效');
    }
    if (input.credentialMode === 'named' && checkedRoots.length && !checkedRoots.some(root =>
      input.credentialPath === root || input.credentialPath!.startsWith(root + '/')))
      throw new HttpError(400, '主凭据文件必须位于配置的凭据目录内');
    if (new Set(checkedRoots).size !== checkedRoots.length) throw new HttpError(400, '认证文件根目录不能重复');
    for (let i = 0; i < checkedRoots.length; i++) {
      for (let j = i + 1; j < checkedRoots.length; j++) {
        if (checkedRoots[i].startsWith(`${checkedRoots[j]}/`) || checkedRoots[j].startsWith(`${checkedRoots[i]}/`))
          throw new HttpError(400, '认证文件根目录不能互相包含');
      }
    }
    for (const id of [input.permissionScriptId, input.credentialParseScriptId, input.credentialSaveScriptId]) {
      if (id && this.repository.scripts && !await this.repository.scripts.get(id)) throw new HttpError(400, '工具引用的脚本不存在');
    }
    await this.execution(input);
  }
  async execution(tool: DynamicToolInput): Promise<DynamicToolExecution> {
    const executable = tool.packageVersion ? await this.packages.executable(tool.packageVersion, tool.executable) : tool.executable;
    if (executable === 'cocell' || executable === '/usr/local/bin/cocell') throw new HttpError(400, '工具入口不能指向调度器自身');
    try { return validateDynamicToolExecution({ executable, args: tool.args, env: tool.env, timeoutMs: tool.timeoutMs }); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  }
  save(input: DynamicToolInput, version?: number) {
    return this.serial(async () => {
      await this.validate(input);
      const saved = await this.repository.save(input, version);
      await this.publish();
      return saved;
    });
  }
  delete(name: string, version: number) {
    return this.serial(async () => {
      toolName(name);
      await this.repository.delete(name, version);
      await this.publish();
      return { ok: true as const };
    });
  }
  /** Definitions are loaded afresh under the shared lock; restarts never reset operator changes. */
  private async publish() {
    const tools = (await this.repository.list()).filter(tool => tool.enabled);
    const catalog = JSON.stringify(tools.map(({ name, description, instructions }) => ({ name, description, instructions })));
    const files = [{ path: 'catalog.json', content: catalog, mode: 0o644 }, ...tools.map(tool => ({
      path: `bin/${tool.name}`, mode: 0o755,
      content: `#!/bin/sh\nexec /usr/local/bin/node /opt/product/cocell/tool-client.mjs --dynamic '${tool.name}' "$@"\n`,
    }))];
    const version = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    const versions = join(this.root, 'versions');
    await toolDirectory(this.root);
    await toolDirectory(versions);
    const staging = await mkdtemp(join(versions, '.publish-'));
    try {
      await chmod(staging, 0o755);
      await mkdir(join(staging, 'bin'), { mode: 0o755 });
      await chmod(join(staging, 'bin'), 0o755);
      for (const file of files) {
        await writeFile(join(staging, file.path), file.content, { flag: 'wx', mode: file.mode });
        await chmod(join(staging, file.path), file.mode);
      }
      const target = join(versions, version);
      try { await rename(staging, target); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe tool catalog generation');
      const bin = await lstat(join(target, 'bin'));
      if (!bin.isDirectory() || bin.isSymbolicLink()) throw new Error('Unsafe tool shortcut directory');
      for (const file of files) {
        const path = join(target, file.path);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || await readFile(path, 'utf8') !== file.content || (info.mode & 0o777) !== file.mode)
          throw new Error('Published tool catalog contents changed');
      }
      const pointer = join(this.root, `.current-${randomUUID()}`);
      try { await symlink(`versions/${version}`, pointer); await rename(pointer, join(this.root, 'current')); }
      finally { await unlink(pointer).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
