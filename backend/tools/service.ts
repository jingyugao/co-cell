import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DynamicToolCreateInput, DynamicToolExecution, DynamicToolInput } from '../../protocol/tool-types.js';
import { validateDynamicToolExecution } from '../../util/dynamic-tool-config.mjs';
import { HttpError } from '../../util/errors.js';
import { credentialPath, toolName } from '../secrets/policy.js';
import { registeredTools } from '../tool-access/index.js';
import type { SharedCoordinator } from '../infra/storage/coordination.js';
import type { ToolRepository } from './repository.js';
import { ToolPackages, toolDirectory } from './packages.js';
import { isDynamicBuiltin, builtinToolDefault } from './defaults.js';
import { validatePermissionScript } from './permission-script.js';

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
    const builtin = builtinToolDefault(input.name);
    const definition: DynamicToolInput = {
      name: input.name,
      description: input.description ?? builtin?.description ?? '',
      instructions: input.instructions ?? builtin?.instructions ?? '',
      enabled: input.enabled ?? builtin?.enabled ?? true,
      executable: input.executable ?? builtin?.executable ?? input.name,
      ...(input.packageVersion ? { packageVersion: input.packageVersion } : {}),
      args: input.args ?? builtin?.args ?? [],
      env: input.env ?? builtin?.env ?? {},
      ...(input.credentialPath ?? builtin?.credentialPath ? { credentialPath: input.credentialPath ?? builtin?.credentialPath } : {}),
      ...(input.credentialPaths ?? builtin?.credentialPaths ? { credentialPaths: input.credentialPaths ?? builtin?.credentialPaths } : {}),
      ...(input.permissionScript ?? builtin?.permissionScript ? { permissionScript: input.permissionScript ?? builtin?.permissionScript } : {}),
      ...(input.permissionScriptId ?? builtin?.permissionScriptId
        ? { permissionScriptId: input.permissionScriptId ?? builtin?.permissionScriptId } : {}),
      ...(input.credentialParseScriptId ?? builtin?.credentialParseScriptId
        ? { credentialParseScriptId: input.credentialParseScriptId ?? builtin?.credentialParseScriptId } : {}),
      ...(input.credentialSaveScriptId ?? builtin?.credentialSaveScriptId
        ? { credentialSaveScriptId: input.credentialSaveScriptId ?? builtin?.credentialSaveScriptId } : {}),
      timeoutMs: input.timeoutMs ?? builtin?.timeoutMs ?? 20000,
    };
    return this.save(definition);
  }
  private async validate(input: DynamicToolInput) {
    toolName(input.name);
    if (['cocell', 'help', 'list', 'cellbox-container-agent', ...registeredTools().filter(tool => !isDynamicBuiltin(tool.name)).map(tool => tool.name)].includes(input.name))
      throw new HttpError(400, '此名称由内置工具保留，请使用其他工具名');
    if (input.credentialPath) credentialPath(input.credentialPath);
    const roots = input.credentialPaths ?? [];
    if (roots.length > 16) throw new HttpError(400, '认证文件根目录最多支持 16 个');
    const checkedRoots = roots.map(credentialPath);
    if (new Set(checkedRoots).size !== checkedRoots.length) throw new HttpError(400, '认证文件根目录不能重复');
    for (let i = 0; i < checkedRoots.length; i++) {
      for (let j = i + 1; j < checkedRoots.length; j++) {
        if (checkedRoots[i].startsWith(`${checkedRoots[j]}/`) || checkedRoots[j].startsWith(`${checkedRoots[i]}/`))
          throw new HttpError(400, '认证文件根目录不能互相包含');
      }
    }
    if (input.name === 'mysql' && input.credentialPath !== '.mylogin.cnf')
      throw new HttpError(400, 'MySQL 使用固定的原生 .mylogin.cnf 配置文件');
    validatePermissionScript(input.permissionScript);
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
      let definition = input;
      let createdScript: { id: string; version: number } | undefined;
      if (input.permissionScript !== undefined && this.repository.scripts) {
        const current = await this.repository.get(input.name);
        if (version === undefined ? current !== undefined : current?.version !== version) throw new HttpError(409, '工具已被修改或删除，请重新加载');
        const script = await this.repository.scripts.save({ name: `${input.name} permission ${randomUUID().slice(0, 8)}`, language: 'typescript', source: input.permissionScript });
        createdScript = script;
        const { permissionScript: _inline, ...rest } = input;
        definition = { ...rest, permissionScriptId: script.id };
      }
      let saved;
      try { saved = await this.repository.save(definition, version); }
      catch (error) {
        if (createdScript) await this.repository.scripts!.delete(createdScript.id, createdScript.version).catch(() => {});
        throw error;
      }
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
