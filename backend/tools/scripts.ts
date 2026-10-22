import type { DynamicToolInput, ToolPermissionCheckInput } from '../../protocol/tool-types.js';
import type { ToolScriptInput } from '../../protocol/tool-script-types.js';
import { HttpError } from '../../util/errors.js';
import type { ToolScriptRepository } from './script-repository.js';
import { runToolScript, validateCredentialScript } from './credential-script.js';
import { checkToolPermission } from './permission-script.js';

/** One operator-owned script catalog for every tool hook. */
export class ToolScripts {
  private npmCache?: string;
  constructor(private repository: ToolScriptRepository | undefined,
    private coordinate: <T>(action: () => Promise<T>) => Promise<T> = action => action()) {}
  list() { return this.repository?.list() ?? Promise.resolve([]); }
  configureCache(path: string) { this.npmCache = path; }
  async get(id: string) {
    const script = await this.repository?.get(id);
    if (!script) throw new HttpError(404, '脚本不存在或已删除');
    return script;
  }
  save(input: ToolScriptInput, id?: string, version?: number) {
    validateCredentialScript(input.source, input.language);
    if (!input.name.trim() || input.name.length > 100) throw new HttpError(400, '请填写最多 100 字的脚本名称');
    if (!this.repository) throw new HttpError(503, '脚本目录尚未初始化');
    return this.coordinate(() => this.repository!.save({ ...input, name: input.name.trim() }, id, version));
  }
  delete(id: string, version: number) {
    if (!this.repository) throw new HttpError(503, '脚本目录尚未初始化');
    return this.coordinate(async () => { await this.repository!.delete(id, version); return { ok: true as const }; });
  }
  async checkPermission(tool: DynamicToolInput | undefined, input: ToolPermissionCheckInput) {
    if (!tool?.permissionScriptId) return checkToolPermission(tool?.permissionScript, input);
    const script = await this.get(tool.permissionScriptId);
    let result;
    try { result = await runToolScript(script.source, input, { language: script.language, npmCache: this.npmCache }); }
    catch (error) {
      if (error instanceof HttpError && error.status === 503) throw error;
      throw new HttpError(403, '工具权限检查未通过');
    }
    if (result === true || typeof result === 'object' && result.allow) return;
    const reason = typeof result === 'object' ? result.reason : undefined;
    throw new HttpError(403, reason?.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000) || '工具权限检查未通过');
  }
}
