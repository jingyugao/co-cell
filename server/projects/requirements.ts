import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { HttpError } from '../core/errors.js';

const exec = promisify(execFile);
type Command = (args: string[]) => Promise<string>;
const command: Command = async args => {
  const result = await exec('meegle', args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout;
};
const decodedSchema = z.object({
  url_kind: z.string(), host: z.string(), simple_name: z.string().optional(), work_item_id: z.string().optional(),
});
const statusSchema = z.object({ authenticated: z.boolean(), host: z.string().nullish() });
const projectsSchema = z.object({
  projects: z.array(z.object({ project_key: z.string().min(1), simple_name: z.string() })),
  pagination: z.object({ has_more: z.boolean() }).optional(),
});
const detailSchema = z.object({ work_item_attribute: z.object({
  work_item_id: z.string(), work_item_name: z.string().trim().min(1),
  owned_project: z.object({ key: z.string() }),
  status: z.union([z.string(), z.object({ name: z.string().optional(), value: z.string().optional() })]).optional(),
}) });
export type RequirementInfo = { name: string; status: string | null };

/** Read requirement metadata using the host's logged-in Meegle CLI, never a URL fetch or shell. */
export async function readRequirementName(url: string, run: Command = command): Promise<string> {
  return (await readRequirementInfo(url, run)).name;
}

export async function readRequirementInfo(url: string, run: Command = command): Promise<RequirementInfo> {
  async function read<T>(args: string[], schema: z.ZodType<T>, failure: string): Promise<T> {
    try { return schema.parse(JSON.parse(await run([...args, '--format', 'json']))); }
    // CLI errors may contain credentials or remote content; only expose our stage-specific message.
    catch { throw new HttpError(502, failure); }
  }
  const decoded = await read(['url', 'decode', '--url', url], decodedSchema, '无法解析飞书需求链接，请确认链接格式及本机 Meegle CLI 是否可用');
  if (decoded.url_kind !== 'workitem_detail' || !decoded.simple_name || !decoded.work_item_id) {
    throw new HttpError(400, '请填写飞书项目的具体需求详情链接，不能使用空间首页、列表或文档链接');
  }
  const authStatus = await read(['auth', 'status'], statusSchema, '无法检查飞书项目登录状态，请检查本机 Meegle 登录及网络后重试');
  if (!authStatus.authenticated) throw new HttpError(409, '飞书项目尚未登录或登录已失效，请先在本机完成 Meegle 登录');
  const hostname = (value: string) => {
    try { return new URL(value.includes('://') ? value : `https://${value}`).host.toLowerCase(); }
    catch { return ''; }
  };
  if (!authStatus.host || !hostname(authStatus.host) || hostname(authStatus.host) !== hostname(decoded.host)) {
    throw new HttpError(400, '需求链接的站点与当前 Meegle 登录站点不一致，请检查链接或切换登录站点');
  }
  const projects = await read(['project', 'search', '--project-key', decoded.simple_name], projectsSchema,
    '读取飞书项目空间失败，请检查访问权限、登录状态及网络后重试');
  const matches = projects.projects.filter(project => project.simple_name === decoded.simple_name);
  if (matches.length !== 1 || projects.pagination?.has_more) {
    throw new HttpError(400, '无法唯一确定需求所属空间，请检查需求链接及当前账号的空间权限');
  }
  const projectKey = matches[0].project_key;
  const detail = await read(['workitem', 'get', '--project-key', projectKey, '--work-item-id', decoded.work_item_id,
    '--select', 'work_item_attribute.work_item_id,work_item_attribute.work_item_name,work_item_attribute.owned_project.key,work_item_attribute.status'], detailSchema,
  '读取飞书需求名称失败，请确认需求存在且当前账号有权限，并检查登录状态及网络后重试');
  if (detail.work_item_attribute.work_item_id !== decoded.work_item_id || detail.work_item_attribute.owned_project.key !== projectKey) {
    throw new HttpError(502, '飞书返回的需求与链接不匹配，请检查链接后重试');
  }
  // Project names are limited to 100 UTF-16 code units; avoid cutting a surrogate pair.
  const name = detail.work_item_attribute.work_item_name.slice(0, 100).replace(/[\uD800-\uDBFF]$/u, '');
  const itemStatus = detail.work_item_attribute.status;
  return { name, status: typeof itemStatus === 'string' ? itemStatus : itemStatus?.name || itemStatus?.value || null };
}
