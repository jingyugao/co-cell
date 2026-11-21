import { setTimeout as delay } from 'node:timers/promises';
import type { CellboxClient } from '@co-cell/sandbox';
import { posix } from 'node:path';
import type { Check } from '../../packages/workflow/src/index.js';
import { redactCredentials } from '../../util/errors.js';

// Runs inside the Box. Hash dirty and untracked files as well as tracked files.
// A capped or unreadable inventory must block integration, never yield a partial digest.
const enterProject = String.raw`
const boxRoot = require('node:fs').realpathSync('.');
const projectRoot = require('node:fs').realpathSync(process.argv.splice(1,1)[0]);
if (projectRoot !== boxRoot && !projectRoot.startsWith(boxRoot+'/')) throw Error('项目目录越出 Sandbox 工作区');
process.chdir(projectRoot);
`;
const fingerprintScript = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const groups = JSON.parse(process.argv[1]), hashes = new Map();
for (const group of groups) for (const declared of [...group.paths,...(group.inspect || [])]) {
  let current = '.';
  for (const part of declared.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('声明路径经过符号链接 '+current); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
}
let files = 0, bytes = 0;
function walk(dir) {
  const names = fs.readdirSync(dir).sort();
  for (const name of names) {
    if (['.git','.cocell','node_modules'].includes(name)) continue;
    const p = path.join(dir,name), s = fs.lstatSync(p);
    if (++files > 50000) throw Error('文件指纹超过 50000 项上限');
    let value;
    if (s.isSymbolicLink()) value = 'link:' + fs.readlinkSync(p);
    else if (s.isDirectory()) { walk(p); continue; }
    else if (s.isFile()) {
      bytes += s.size;
      if (s.size > 32*1024*1024 || bytes > 512*1024*1024) throw Error('文件指纹超过读取上限');
      value = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    } else throw Error('无法核验特殊文件 ' + p);
    const group = groups.find(g => g.paths.some(root => p === root || p.startsWith(root+'/')))?.id || 'other';
    if (!hashes.has(group)) hashes.set(group, crypto.createHash('sha256'));
    hashes.get(group).update(JSON.stringify([p,s.mode,value])+'\n');
  }
}
walk('.');
console.log(JSON.stringify(Object.fromEntries([...hashes].map(([key,h])=>[key,h.digest('hex')]))));
`;
const validationScript = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const [rel, ...argv] = process.argv.slice(1), root = fs.realpathSync('.'), cwd = fs.realpathSync(rel);
if (cwd !== root && !cwd.startsWith(root+'/')) throw Error('验证目录越出项目');
const child = cp.spawn(argv[0], argv.slice(1), {cwd,stdio:'inherit',shell:false});
child.on('error', e => { console.error(e.message); process.exitCode=1 });
child.on('exit',(code,signal)=>{process.exitCode=code ?? 1});
`;
type Context = { boxId: string; workspace: string };
export class WorkflowValidationRunner {
  constructor(private client: Pick<CellboxClient, 'getBox' | 'exec' | 'getOperation' | 'getExec'>) {}
  private async start(
    ctx: Context,
    script: string,
    args: string[],
    timeoutMs: number,
    guard?: () => Promise<void>
  ) {
    const box = await this.client.getBox(ctx.boxId);
    if (
      box.id !== ctx.boxId ||
      box.phase !== 'running' ||
      !posix.isAbsolute(ctx.workspace) ||
      (ctx.workspace !== box.workspace && !ctx.workspace.startsWith(box.workspace + '/'))
    )
      throw Error('工作区或 Sandbox 身份已变化');
    await guard?.();
    const op = await this.client.exec(box.id, {
      argv: [
        '/usr/local/bin/node',
        '-e',
        enterProject + script,
        '--',
        posix.relative(box.workspace, ctx.workspace) || '.',
        ...args,
      ],
      cwd: box.workspace,
      expectedGeneration: box.generation,
      timeoutMs,
    });
    if (!op.id || op.targetId !== box.id) throw Error('Cellbox 未确认验证操作身份');
    return op.id;
  }
  startValidation(ctx: Context, check: Check, guard: () => Promise<void>) {
    return this.start(ctx, validationScript, [check.cwd, ...check.argv], check.timeoutMs, guard);
  }
  async observe(boxId: string, id: string, waitMs = 0) {
    const op = await this.client.getOperation(id, undefined, waitMs);
    if (op.id !== id || op.targetId !== boxId || (op.kind && op.kind !== 'exec'))
      throw Error('验证操作身份不匹配');
    if (op.status === 'running' || op.status === 'queued') return undefined;
    if (!op.result?.execId) throw Error('验证命令结果未知：' + (op.error?.message ?? id));
    const exec = await this.client.getExec(op.result.execId);
    if (
      exec.id !== op.result.execId ||
      exec.boxId !== boxId ||
      exec.operationId !== id ||
      exec.state !== 'exited' ||
      !exec.result ||
      exec.result.exitCode === 124
    )
      throw Error('验证命令退出状态未知');
    return exec.result;
  }
  async fingerprint(ctx: Context, groups: { id: string; paths: string[]; inspect?: string[] }[]) {
    const id = await this.start(ctx, fingerprintScript, [JSON.stringify(groups)], 60000);
    const deadline = Date.now() + 70000;
    while (Date.now() < deadline) {
      const result = await this.observe(ctx.boxId, id, 2000);
      if (result) {
        if (result.exitCode || result.truncated)
          throw Error(redactCredentials(result.stderr).slice(-500) || '文件指纹不完整');
        const map: Record<string, string> = JSON.parse(result.stdout);
        if (
          !map ||
          typeof map !== 'object' ||
          Array.isArray(map) ||
          Object.values(map).some((v) => !/^[a-f0-9]{64}$/.test(v))
        )
          throw Error('无效的文件指纹');
        return map;
      }
      await delay(100);
    }
    throw Error('文件指纹超时');
  }
}
