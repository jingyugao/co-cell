import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { HttpError } from '../../util/errors.js';
import type { ToolCredentialHookContext } from '../../protocol/tool-credential-types.js';
import type { ToolPermissionDecision } from '../../protocol/tool-types.js';

const maxCredentialBytes = 1024 * 1024;
const maxCredentialBundleBytes = 4 * maxCredentialBytes;
const maxScriptInputBytes = 12 * 1024 * 1024;
const maxScriptBytes = 16000;
const maxConcurrentWorkers = 4;
const workerTimeoutMs = 2000;
const bashTimeoutMs = 30_000;
const maxStderrBytes = 64 * 1024;
const bashPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
let activeWorkers = 0;

export type CredentialEncoding = 'utf8' | 'base64' | 'parsed';
export type CredentialScriptLanguage = 'typescript' | 'bash';
export interface ScriptOptions {
  language?: CredentialScriptLanguage;
  home?: string;
  npmCache?: string;
  files?: Array<{ path: string; content: string }>;
  timeoutMs?: number;
  /** Never forwarded to permission hooks. */
  context?: ToolCredentialHookContext;
}
export type CredentialScriptOptions = ScriptOptions;
export interface ParsedToolCredential { content: string; encoding: 'utf8' | 'base64' | 'parsed'; names?: string[] }
export interface ParseToolCredentialInput { path: string; content: string }
export interface SaveToolCredentialInput { path: string; content: string; encoding: CredentialEncoding; original: string }

function canonicalBase64(value: string): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxCredentialBytes / 3) * 4)
    throw new HttpError(400, '凭证文件大小或格式无效');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxCredentialBytes || bytes.toString('base64') !== value)
    throw new HttpError(400, '凭证文件大小或格式无效');
  return bytes;
}

function validateInput(path: string, content: string) {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 4096 || path.includes('\0'))
    throw new HttpError(400, '凭证文件路径无效');
  if (typeof content !== 'string') throw new HttpError(400, '凭证文件内容无效');
}

function withCredentialFiles<T extends object>(input: T, files: ScriptOptions['files']): T & { files: Array<{ path: string; content: string }> } {
  const seen = new Set<string>();
  let total = 0;
  const normalized = (files ?? []).map(file => {
    validateInput(file.path, file.content);
    if (seen.has(file.path)) throw new HttpError(400, '凭证脚本文件路径重复');
    seen.add(file.path);
    const bytes = canonicalBase64(file.content);
    total += bytes.length;
    if (total > maxCredentialBundleBytes) throw new HttpError(413, '凭证脚本文件总量不能超过 4 MiB');
    return { path: file.path, content: bytes.toString('base64') };
  });
  if (normalized.length > 128) throw new HttpError(413, '凭证脚本文件数量不能超过 128');
  return { ...input, files: normalized };
}

function compiledTypescript(source: string): string {
  const wrapped = `const __run = (input: unknown, codec: any) => {\n"use strict";\n${source}\n};`;
  const result = ts.transpileModule(wrapped, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, strict: true },
  });
  if (result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error))
    throw new HttpError(400, '凭证脚本语法无效');
  return result.outputText.replace(/;?\s*$/, '');
}

export function validateCredentialScript(source?: string, language: CredentialScriptLanguage = 'typescript'): void {
  if (source === undefined) return;
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > maxScriptBytes || source.includes('\0'))
    throw new HttpError(400, '脚本不能为空且不能超过 16000 字节');
  if (language !== 'typescript' && language !== 'bash') throw new HttpError(400, '凭证脚本语言无效');
  try {
    if (language === 'typescript') {
      const compiled = compiledTypescript(source);
      if (!compiled.includes('__run')) throw new Error('invalid script');
    } else {
      const result = spawnSync('/bin/bash', ['-n'], { input: source, encoding: 'utf8', timeout: 1000, maxBuffer: 4096, env: {} });
      if (result.error || result.status !== 0) throw new Error('invalid script');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '凭证脚本语法无效');
  }
}

async function runTypescriptCredentialScript(source: string, input: unknown, resultMode: 'credential' | 'credential-load' | 'credential-save' | 'general' = 'credential', timeoutMs = workerTimeoutMs): Promise<unknown> {
  const compiledSource = compiledTypescript(source);
  if (activeWorkers >= maxConcurrentWorkers) throw new HttpError(503, '凭证脚本繁忙，请稍后重试');
  activeWorkers++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const inputJson = JSON.stringify(input);
    if (inputJson === undefined) throw new HttpError(400, '凭证脚本输入无效');
    if (Buffer.byteLength(inputJson) > maxScriptInputBytes) throw new HttpError(400, '凭证脚本输入过大');
    const outcome = await new Promise<{ response: unknown } | { failure: string }>(resolve => {
      worker = new Worker(new URL('./credential-worker.mjs', import.meta.url), {
        execArgv: [], env: {}, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8, stackSizeMb: 1 },
        workerData: { source: compiledSource, inputJson, resultMode, timeoutMs },
      });
      worker.stdout?.resume();
      worker.stderr?.resume();
      worker.once('message', value => resolve(value && typeof value === 'object' && typeof value.error === 'string'
        ? { failure: value.error } : { response: value }));
      worker.once('error', error => resolve({ failure: error.message }));
      worker.once('exit', code => resolve({ failure: `脚本 worker 已退出（code ${code}）` }));
      timer = setTimeout(() => resolve({ failure: `脚本执行超时（${timeoutMs}ms）` }), timeoutMs);
    });
    if ('failure' in outcome) throw new HttpError(400, outcome.failure);
    const { response } = outcome;
    const maxResponseBytes = resultMode === 'general' ? 4096 : resultMode === 'credential-save' ? Math.ceil(maxCredentialBytes / 3) * 4 + 16 : 8 * 1024 * 1024;
    if (typeof response !== 'string' || Buffer.byteLength(response) > maxResponseBytes) throw new HttpError(400, '脚本输出无效或超过大小限制');
    try { return JSON.parse(response); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  } finally {
    clearTimeout(timer);
    try { if (worker) await worker.terminate(); }
    finally { activeWorkers--; }
  }
}

function boundedOutput(child: ReturnType<typeof spawn>, maxBytes: number): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolveOutput, rejectOutput) => {
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let settled = false;
    const terminate = () => { if (child.pid) { try { globalThis.process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* exited */ } } } };
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!settled) { settled = true; terminate(); rejectOutput(new HttpError(400, '凭证脚本输出超过 1 MiB')); }
      } else chunks.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errorSize < maxStderrBytes) { errors.push(Buffer.from(chunk)); errorSize += chunk.length; }
    });
    child.once('error', error => {
      if (!settled) { settled = true; rejectOutput(new HttpError(400, error.message)); }
    });
    child.once('close', code => {
      if (!settled) { settled = true; resolveOutput({ code, stdout: Buffer.concat(chunks, size), stderr: Buffer.concat(errors).subarray(0, maxStderrBytes).toString('utf8') }); }
    });
  });
}

/** Report a failed Bash hook with its own stderr. */
function bashFailure(result: { code: number | null; stderr: string }, timedOut: boolean, timeoutMs: number) {
  if (timedOut) throw new HttpError(400, `脚本执行超时（${timeoutMs}ms）${result.stderr.trim() ? `：${result.stderr.trim()}` : ''}`);
  if (result.code !== 0) throw new HttpError(400, result.stderr.trim() || `脚本退出码 ${result.code}`);
}

async function readStagedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new HttpError(400, '凭证脚本输出必须是普通文件');
    if (initial.size > maxCredentialBytes) throw new HttpError(400, '凭证脚本输出超过 1 MiB');
    const bytes = Buffer.alloc(maxCredentialBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > maxCredentialBytes) throw new HttpError(400, '凭证脚本输出超过 1 MiB');
    const current = await handle.stat();
    if (count !== initial.size || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs)
      throw new HttpError(409, '凭证脚本暂存文件已改变');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

function boundedTimeout(timeoutMs: number | undefined, fallback: number): number {
  return timeoutMs === undefined ? fallback : Math.max(1, Math.min(30_000, Math.floor(timeoutMs)));
}

async function runBashRaw(source: string, input: unknown, options: ScriptOptions = {}, timeoutMs = bashTimeoutMs, maxOutputBytes = maxCredentialBytes): Promise<Buffer> {
  validateCredentialScript(source, 'bash');
  if (activeWorkers >= maxConcurrentWorkers) throw new HttpError(503, '凭证脚本繁忙，请稍后重试');
  activeWorkers++;
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let temporaryHome: string | undefined;
  try {
    const home = options.home ? resolve(options.home) : (temporaryHome = await mkdtemp(resolve(tmpdir(), 'cocell-tool-script-')));
    await mkdir(home, { recursive: true, mode: 0o700 });
    const inputJson = JSON.stringify(input);
    if (inputJson === undefined || Buffer.byteLength(inputJson) > maxScriptInputBytes) throw new HttpError(400, '凭证脚本输入过大');
    child = spawn('/bin/bash', ['-c', source], {
      cwd: home,
      env: {
        HOME: home, PATH: bashPath, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        ...(options.npmCache ? { npm_config_cache: resolve(options.npmCache) } : {}),
      },
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outputPromise = boundedOutput(child, maxOutputBytes);
    child.stdin?.on('error', () => {});
    child.stdin?.end(inputJson);
    let timedOut = false;
    timer = setTimeout(() => { timedOut = true; if (child?.pid) { try { globalThis.process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* exited */ } } } }, timeoutMs);
    const result = await outputPromise;
    bashFailure(result, timedOut, timeoutMs);
    return result.stdout;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    if (child?.pid) { try { globalThis.process.kill(-child.pid, 'SIGKILL'); } catch { if (child.exitCode === null) child.kill('SIGKILL'); } }
    if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
    activeWorkers--;
  }
}

function permissionResult(value: unknown): value is boolean | ToolPermissionDecision {
  if (typeof value === 'boolean') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Object.keys(result).every(key => key === 'allow' || key === 'reason' || key === 'credential') &&
    typeof result.allow === 'boolean' &&
    (result.credential === undefined || (typeof result.credential === 'string' && !!result.credential &&
      Buffer.byteLength(result.credential) <= 256 && !/[\u0000-\u001f\u007f]/.test(result.credential))) &&
    (result.reason === undefined || (typeof result.reason === 'string' && Buffer.byteLength(result.reason) <= 1000));
}

/** Run a central permission/configuration script and return a strict JSON decision. */
export async function runToolScript(
  source: string,
  input: unknown,
  options: ScriptOptions = {},
): Promise<boolean | ToolPermissionDecision> {
  const language = options.language ?? 'typescript';
  const timeoutMs = boundedTimeout(options.timeoutMs, language === 'bash' ? 5000 : 1000);
  validateCredentialScript(source, language);
  let output: unknown;
  if (language === 'bash') {
    const stdout = await runBashRaw(source, input, options, timeoutMs, 4096);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
    output = parsed;
  } else output = await runTypescriptCredentialScript(source, input, 'general', timeoutMs);
  if (!permissionResult(output))
    throw new HttpError(400, '权限脚本返回值必须是 boolean 或 {allow, reason?, credential?}');
  return output;
}

function safeStagedPath(home: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).some(part => part === '..'))
    throw new HttpError(400, '凭证文件路径无效');
  const target = resolve(home, path);
  const rel = relative(home, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new HttpError(400, '凭证文件路径无效');
  return target;
}

async function materializeFiles(home: string, files: CredentialScriptOptions['files'], selectedPath: string, selectedBytes: Buffer): Promise<string> {
  if (!home || !isAbsolute(home)) throw new HttpError(400, '凭证脚本暂存目录无效');
  const root = resolve(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files ?? []) {
    validateInput(file.path, file.content);
    const bytes = canonicalBase64(file.content);
    const target = safeStagedPath(root, file.path);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
  }
  const selected = safeStagedPath(root, selectedPath);
  await mkdir(resolve(selected, '..'), { recursive: true, mode: 0o700 });
  await writeFile(selected, selectedBytes, { mode: 0o600 });
  return selected;
}

async function runBashCredentialScript(source: string, input: object, options: CredentialScriptOptions, selectedOriginal: Buffer, selectedPath: string, maxOutputBytes = maxCredentialBytes): Promise<{stdout: Buffer; selected?: Buffer}> {
  validateCredentialScript(source, 'bash');
  if (activeWorkers >= maxConcurrentWorkers) throw new HttpError(503, '凭证脚本繁忙，请稍后重试');
  if (!options.home) throw new HttpError(400, '凭证脚本暂存目录无效');
  const selected = await materializeFiles(options.home, options.files, selectedPath, selectedOriginal);
  activeWorkers++;
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const inputJson = JSON.stringify(input);
    if (inputJson === undefined || Buffer.byteLength(inputJson) > maxScriptInputBytes) throw new HttpError(400, '凭证脚本输入过大');
    child = spawn('/bin/bash', ['-c', source], {
      cwd: resolve(options.home),
      env: {
        HOME: resolve(options.home), PATH: bashPath, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        ...(options.npmCache ? { npm_config_cache: resolve(options.npmCache) } : {}),
        COCELL_CREDENTIAL_PATH: selected,
        COCELL_CREDENTIAL_FILE: selected,
      },
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outputPromise = boundedOutput(child, maxOutputBytes);
    child.stdin?.on('error', () => {});
    child.stdin?.end(inputJson);
    const timeoutMs = boundedTimeout(options.timeoutMs, bashTimeoutMs);
    let timedOut = false;
    timer = setTimeout(() => { timedOut = true; if (child?.pid) { try { globalThis.process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* exited */ } } } }, timeoutMs);
    const result = await outputPromise;
    bashFailure(result, timedOut, timeoutMs);
    const current = await readStagedFile(selected);
    return { stdout: result.stdout, ...(current.equals(selectedOriginal) ? {} : { selected: current }) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    if (child?.pid) { try { globalThis.process.kill(-child.pid, 'SIGKILL'); } catch { if (child.exitCode === null) child.kill('SIGKILL'); } }
    activeWorkers--;
  }
}

/** Parse a canonical base64 file value into a safe editor representation. */
export async function parseToolCredential(source: string | undefined, input: ParseToolCredentialInput, options: CredentialScriptOptions = {}): Promise<ParsedToolCredential> {
  validateInput(input.path, input.content);
  const bytes = canonicalBase64(input.content);
  if (source === undefined) {
    if (bytes.includes(0)) return { content: input.content, encoding: 'base64' };
    try { return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'utf8' }; }
    catch { return { content: input.content, encoding: 'base64' }; }
  }
  validateCredentialScript(source, options.language);
  let result: unknown;
  if (options.language === 'bash') {
    const ran = await runBashCredentialScript(source, withCredentialFiles({ ...options.context, ...input }, options.files), options, bytes, input.path, 8 * 1024 * 1024);
    let output: string;
    try { output = new TextDecoder('utf-8', { fatal: true }).decode(ran.stdout); }
    catch { throw new HttpError(400, '凭证解析脚本输出不是有效 UTF-8'); }
    try { result = JSON.parse(output); }
    catch { result = output; }
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const object = result as Record<string, unknown>;
      if (typeof object.content === 'string' && Object.keys(object).every(key => ['content', 'encoding', 'names'].includes(key))) result = object;
      else result = JSON.stringify(result, null, 2);
    } else if (typeof result !== 'string') result = JSON.stringify(result, null, 2);
  } else result = await runTypescriptCredentialScript(source, withCredentialFiles({ ...options.context, ...input }, options.files), 'credential-load', boundedTimeout(options.timeoutMs, workerTimeoutMs));
  if (typeof result === 'string') {
    if (Buffer.byteLength(result) > maxCredentialBytes) throw new HttpError(400, '凭证解析结果超过 1 MiB');
    return { content: result, encoding: 'parsed' };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(400, '凭证解析脚本返回值无效');
  const value = result as Record<string, unknown>;
  const encoding = value.encoding === undefined ? 'parsed' : value.encoding;
  if (Object.keys(value).some(key => !['content', 'encoding', 'names'].includes(key)) || typeof value.content !== 'string' ||
      !['utf8', 'base64', 'parsed'].includes(encoding as string) ||
      (encoding === 'base64' ? canonicalBase64(value.content).length > maxCredentialBytes : Buffer.byteLength(value.content) > maxCredentialBytes) ||
      (value.names !== undefined && (!Array.isArray(value.names) || value.names.length > 1000 || value.names.some(name => typeof name !== 'string' || Buffer.byteLength(name) > 256))))
    throw new HttpError(400, '凭证解析脚本返回值无效');
  return { content: value.content, encoding: encoding as CredentialEncoding, ...(value.names === undefined ? {} : { names: value.names as string[] }) };
}

/** Encode editor content to canonical base64 bytes, requiring a saver for parsed data. */
export async function saveToolCredential(source: string | undefined, input: SaveToolCredentialInput, options: CredentialScriptOptions = {}): Promise<Buffer> {
  validateInput(input.path, input.content);
  const original = canonicalBase64(input.original);
  if (!['utf8', 'base64', 'parsed'].includes(input.encoding)) throw new HttpError(400, '凭证文件编码无效');
  if (source === undefined) {
    if (input.encoding === 'base64') return canonicalBase64(input.content);
    if (Buffer.byteLength(input.content) > maxCredentialBytes) throw new HttpError(400, '凭证文件大小超过 1 MiB');
    if (input.encoding === 'utf8') return Buffer.from(input.content, 'utf8');
    throw new HttpError(400, '该凭证格式需要对应的保存脚本');
  }
  if (input.encoding === 'base64') canonicalBase64(input.content);
  else if (Buffer.byteLength(input.content) > maxCredentialBytes) throw new HttpError(400, '凭证文件大小超过 1 MiB');
  validateCredentialScript(source, options.language);
  if (options.language === 'bash') {
    const ran = await runBashCredentialScript(source, withCredentialFiles({ ...options.context, ...input, original: original.toString('base64') }, options.files), options, original, input.path);
    const output = ran.selected ?? ran.stdout;
    if (output.length > maxCredentialBytes) throw new HttpError(400, '凭证保存结果超过 1 MiB');
    return output;
  }
  const result = await runTypescriptCredentialScript(source, withCredentialFiles({ ...options.context, ...input, original: original.toString('base64') }, options.files), 'credential-save', boundedTimeout(options.timeoutMs, workerTimeoutMs));
  if (typeof result !== 'string') throw new HttpError(400, '凭证保存脚本返回值无效');
  return canonicalBase64(result);
}
