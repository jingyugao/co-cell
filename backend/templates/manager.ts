import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { TemplateBuild, TemplateDefinition, TemplateInventory, TemplateManifest } from '../../shared/template-types.js';
import { HttpError } from '../core/errors.js';

const pinned = z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/);
const versions = z.array(pinned).min(1).max(20).refine(items => new Set(items).size === items.length, '版本不能重复');
const binary = z.object({ version: pinned, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const templateManifestSchema = z.object({
  template: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
  systemPackages: z.array(z.string().max(100).regex(/^[a-z0-9][a-z0-9+.-]*$/)).min(1).max(100),
  extraMiseTools: z.array(z.string().max(150).regex(/^[a-z][a-z0-9_-]*@\d+\.\d+\.\d+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/)).max(30)
    .refine(items => items.every(item => !/^(go|node|python|php)@/.test(item)), 'Go、Node、Python、PHP 请使用专用版本配置'),
  go: versions, node: versions, python: versions,
  php: z.object({ version: z.literal('8.0.30'), composer: binary }).strict().optional(),
  defaults: z.object({ go: pinned, node: pinned, python: pinned }).strict(),
  mise: binary, uv: binary, pnpm: pinned, codexCli: z.literal('0.153.4'),
  cpuCount: z.number().int().min(1).max(8),
  memoryMB: z.number().int().min(512).max(8192).multipleOf(256),
}).strict().superRefine((value, ctx) => {
  for (const language of ['go', 'node', 'python'] as const) {
    if (!value[language].includes(value.defaults[language])) ctx.addIssue({ code: 'custom', path: ['defaults', language], message: '默认版本必须在安装列表中' });
  }
});
const draftSchema = z.object({ name: z.string().trim().min(1).max(100), manifest: templateManifestSchema }).strict();
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const running = (job: TemplateBuild) => job.status === 'building' || job.status === 'verifying';
const LOG_LIMIT = 128 * 1024;
function clean(value: string, secrets: string[] = []): string {
  let result = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  for (const secret of secrets) if (secret.length >= 6) result = result.split(secret).join('[REDACTED]');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(name) && secret && secret.length >= 6) result = result.split(secret).join('[REDACTED]');
  }
  return result.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]').replace(/\b(?:sk-|e2b_)[a-zA-Z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(/(base64\s+-d[^\n]*|[A-Za-z0-9+/=]{1000,})/g, '[encoded build input omitted]');
}
export interface TemplateRunRequest { script: string; args: string[]; onLog: (text: string) => void; signal: AbortSignal }
export type TemplateRunner = (request: TemplateRunRequest) => Promise<void>;
const defaultRunner: TemplateRunner = ({ script, args, onLog, signal }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let timer: NodeJS.Timeout | undefined;
  const abort = () => { child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 15000); timer.unref(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  child.stdout.setEncoding('utf8').on('data', onLog);
  child.stderr.setEncoding('utf8').on('data', onLog);
  const finish = () => { signal.removeEventListener('abort', abort); if (timer) clearTimeout(timer); };
  child.once('error', () => { finish(); reject(new Error('无法启动模板构建进程')); });
  child.once('close', code => { finish(); code === 0 ? resolve() : reject(new Error(`模板脚本退出，状态 ${code ?? 'terminated'}`)); });
});
interface State { templates: TemplateDefinition[]; builds: TemplateBuild[]; defaultTemplate: string }
export interface TemplateManagerOptions {
  directory?: string;
  manifestPath?: string;
  legacyDirectory?: string;
  scriptsDirectory?: string;
  initialDefault: string;
  enabled?: boolean;
  onActivate?: (reference: string) => void | Promise<void>;
  runner?: TemplateRunner;
  secrets?: string[];
}
export class TemplateManager {
  private readonly directory: string;
  private readonly scriptsDirectory: string;
  private state: State;
  private tail: Promise<unknown> = Promise.resolve();
  private task?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  private flushTimer?: NodeJS.Timeout;
  constructor(private readonly options: TemplateManagerOptions) {
    this.directory = options.directory ?? fileURLToPath(new URL('../../data/e2b/templates/', import.meta.url));
    this.scriptsDirectory = options.scriptsDirectory ?? fileURLToPath(new URL('../../scripts/e2b/', import.meta.url));
    this.state = { templates: [], builds: [], defaultTemplate: options.initialDefault };
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action); this.tail = next.catch(() => {}); return next;
  }
  private async save() {
    const temp = join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temp, join(this.directory, 'state.json'));
  }
  private parseDraft(input: unknown) {
    const parsed = draftSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'));
    return parsed.data;
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')) as State;
      for (const job of this.state.builds) if (running(job)) {
        job.status = 'interrupted'; job.finishedAt = now(); job.error = '服务重启，之前的构建已中断；请重新构建';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const manifest = templateManifestSchema.parse(JSON.parse(await readFile(this.options.manifestPath ?? join(this.scriptsDirectory, 'toolchains.json'), 'utf8')));
      const definition = this.definition(manifest.template, manifest);
      this.state.templates.push(definition);
      const legacy = this.options.legacyDirectory ?? fileURLToPath(new URL('../../data/e2b/', import.meta.url));
      try {
        const build = JSON.parse(await readFile(join(legacy, 'template-build.json'), 'utf8'));
        const verification = JSON.parse(await readFile(join(legacy, 'template-verification.json'), 'utf8'));
        if (hash(templateManifestSchema.parse(build.manifest)) === hash(manifest) && verification.passed === true &&
          verification.template === build.alias && build.alias === manifest.template && verification.startedAt >= build.builtAt &&
          Array.isArray(verification.checks) && verification.checks.length > 0 && verification.checks.every((check: { failed?: boolean; exitCode?: number }) => !check.failed && (check.exitCode === undefined || check.exitCode === 0))) {
          this.state.builds.push({ id: randomUUID(), templateId: definition.id, templateName: definition.name, status: 'succeeded',
            startedAt: build.builtAt, finishedAt: verification.finishedAt, reference: build.alias, logs: '已导入此前构建与验证结果。\n',
            manifest, verification: this.verification(verification) });
        }
      } catch { /* Legacy evidence is optional; unverified templates cannot be activated. */ }
    }
    await this.save();
    await this.options.onActivate?.(this.state.defaultTemplate);
  }
  private definition(name: string, manifest: TemplateManifest): TemplateDefinition {
    const timestamp = now();
    return { id: randomUUID(), name, manifest, version: hash({ name, manifest, nonce: randomUUID() }), createdAt: timestamp, updatedAt: timestamp };
  }
  private get(id: string) { const value = this.state.templates.find(item => item.id === id); if (!value) throw new HttpError(404, '模板不存在'); return value; }
  private getJob(id: string) { const value = this.state.builds.find(item => item.id === id); if (!value) throw new HttpError(404, '构建不存在'); return value; }
  private match(definition: TemplateDefinition, version: string) { if (definition.version !== version) throw new HttpError(409, '模板已被修改，请刷新后重试'); }
  async list(): Promise<TemplateInventory> {
    await this.tail;
    return structuredClone({ ...this.state, builds: this.state.builds.map(build => ({ ...build, logs: '' })),
      activeBuildId: this.state.builds.find(running)?.id ?? null, enabled: this.options.enabled !== false });
  }
  create(input: { name: string; manifest: TemplateManifest }) { return this.serial(async () => {
    const value = this.parseDraft(input); const definition = this.definition(value.name, value.manifest);
    this.state.templates.push(definition); await this.save(); return structuredClone(definition);
  }); }
  update(id: string, input: { name: string; manifest: TemplateManifest; version: string }) { return this.serial(async () => {
    const definition = this.get(id); this.match(definition, input.version);
    const value = this.parseDraft({ name: input.name, manifest: input.manifest });
    Object.assign(definition, value, { updatedAt: now(), version: hash({ ...value, nonce: randomUUID() }) });
    await this.save(); return structuredClone(definition);
  }); }
  delete(id: string, version: string) { return this.serial(async () => {
    const definition = this.get(id); this.match(definition, version);
    if (this.state.builds.some(job => job.templateId === id && (running(job) || job.reference === this.state.defaultTemplate)) || definition.manifest.template === this.state.defaultTemplate) {
      throw new HttpError(409, '不能删除正在构建或当前默认模板的配置');
    }
    const jobs = this.state.builds.filter(job => job.templateId === id);
    this.state.templates = this.state.templates.filter(item => item.id !== id);
    this.state.builds = this.state.builds.filter(item => item.templateId !== id); await this.save();
    for (const job of jobs) await rm(join(this.directory, 'jobs', job.id), { recursive: true, force: true });
  }); }
  build(id: string, version: string) { return this.serial(async () => {
    if (this.closed) throw new HttpError(503, '服务正在关闭');
    if (this.options.enabled === false) throw new HttpError(400, '尚未启用 E2B');
    const definition = this.get(id); this.match(definition, version);
    if (this.state.builds.some(running)) throw new HttpError(409, '已有模板正在构建，请等待完成');
    const jobId = randomUUID();
    const manifest = structuredClone(definition.manifest);
    const job: TemplateBuild = { id: jobId, templateId: id, templateName: definition.name, status: 'building', startedAt: now(), logs: '', manifest };
    const directory = join(this.directory, 'jobs', jobId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    this.state.builds.unshift(job); await this.save();
    const controller = new AbortController(); this.controller = controller;
    this.task = this.execute(job, directory, controller.signal).catch(error => {
      job.status = controller.signal.aborted ? 'interrupted' : 'failed';
      job.error = clean(error instanceof Error ? error.message : '无法保存构建状态', this.options.secrets).slice(0, 1000);
      job.finishedAt = now();
    });
    return structuredClone(job);
  }); }
  async job(id: string) { await this.tail; return structuredClone(this.getJob(id)); }
  activate(jobId: string) { return this.serial(async () => {
    const job = this.getJob(jobId);
    if (job.status !== 'succeeded' || !job.verification?.passed || !job.reference) throw new HttpError(409, '只有构建并验证成功的模板才能设为默认');
    const previous = this.state.defaultTemplate;
    this.state.defaultTemplate = job.reference;
    try { await this.save(); await this.options.onActivate?.(job.reference); }
    catch (error) { this.state.defaultTemplate = previous; await this.save(); throw error; }
  }).then(() => this.list()); }
  private verification(raw: { passed?: boolean; deleted?: boolean; checks?: Array<{ name?: unknown; output?: unknown; stderr?: unknown; exitCode?: number; failed?: boolean }> }): TemplateBuild['verification'] {
    return { passed: raw.passed === true, deleted: raw.deleted === true, checks: (raw.checks ?? []).slice(0, 200).map(check => ({
      name: clean(String(check.name ?? ''), this.options.secrets).slice(0, 200), output: clean([check.output, check.stderr].filter(value => typeof value === 'string').join('\n'), this.options.secrets).slice(-8192),
      exitCode: check.exitCode, failed: check.failed,
    })) };
  }
  private async execute(job: TemplateBuild, directory: string, signal: AbortSignal) {
    const append = (chunk: string) => {
      job.logs = clean(job.logs + chunk, this.options.secrets).slice(-LOG_LIMIT);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined; void this.serial(() => this.save()).catch(() => {});
      }, 1000);
    };
    let pending = '';
    const log = (chunk: string) => {
      pending += chunk;
      const lastNewline = pending.lastIndexOf('\n');
      if (lastNewline >= 0) { append(pending.slice(0, lastNewline + 1)); pending = pending.slice(lastNewline + 1); }
      if (pending.length > LOG_LIMIT) pending = '[oversized log line omitted]';
    };
    const run = this.options.runner ?? defaultRunner;
    const alias = `codex-web-${job.id}`;
    const args = ['--manifest', join(directory, 'manifest.json'), '--output', directory, '--alias', alias];
    try {
      await run({ script: join(this.scriptsDirectory, 'build-template.mjs'), args, onLog: log, signal });
      if (signal.aborted) throw new Error('构建已中断');
      const result = JSON.parse(await readFile(join(directory, 'template-build.json'), 'utf8'));
      if (result.alias !== alias || hash(templateManifestSchema.parse(result.manifest)) !== hash(job.manifest)) throw new Error('构建结果与本次清单不匹配');
      await this.serial(async () => { job.status = 'verifying'; await this.save(); });
      await run({ script: join(this.scriptsDirectory, 'verify-template.mjs'), args, onLog: log, signal });
      const report = JSON.parse(await readFile(join(directory, 'template-verification.json'), 'utf8'));
      job.verification = this.verification(report);
      if (signal.aborted) throw new Error('构建已中断');
      if (report.template !== alias || report.passed !== true || !Array.isArray(report.checks) || report.checks.length === 0 || report.checks.some((check: { failed?: boolean; exitCode?: number }) => check.failed || (check.exitCode !== undefined && check.exitCode !== 0))) throw new Error('模板验证未通过');
      job.reference = alias; job.status = 'succeeded';
    } catch (error) {
      job.error = clean(error instanceof Error ? error.message : '模板构建失败', this.options.secrets).slice(0, 1000);
      try { job.verification = this.verification(JSON.parse(await readFile(join(directory, 'template-verification.json'), 'utf8'))); } catch { /* Report might not exist on early failure. */ }
      // Publish a terminal state only once its optional failure report is ready;
      // clients stop polling when they see failed/interrupted.
      job.status = signal.aborted ? 'interrupted' : 'failed';
      log(`\n${job.error}\n`);
    } finally {
      if (pending) append(pending);
      job.finishedAt = now();
      if (this.flushTimer) clearTimeout(this.flushTimer); this.flushTimer = undefined;
      await this.serial(() => this.save());
    }
  }
  async close() {
    this.closed = true; await this.tail; this.controller?.abort();
    await this.task;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.tail;
  }
}
