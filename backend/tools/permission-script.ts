import { Script } from 'node:vm';
import { Worker } from 'node:worker_threads';
import type { ToolPermissionCheckInput } from '../../protocol/tool-types.js';
import { HttpError } from '../../util/errors.js';

const maxScriptBytes = 16000;
const maxWorkers = 8;
let activeWorkers = 0;
const functionSource = (source: string) => `(function(input) { "use strict";\n${source}\n})`;

export function validatePermissionScript(source?: string) {
  if (source === undefined) return;
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > maxScriptBytes || source.includes('\0'))
    throw new HttpError(400, '权限检查脚本必须是最多 16000 字节的 JavaScript 函数体');
  try { new Script(functionSource(source)); }
  catch { throw new HttpError(400, '权限检查脚本语法无效'); }
}

// Each invocation gets a fresh VM in a disposable, memory-limited worker. No
// process environment, host objects, files, or network APIs are passed to it.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
try {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
  });
  const source = 'JSON.stringify((' + workerData.source + ')(JSON.parse(' + JSON.stringify(workerData.input) + ')))';
  const result = new vm.Script(source).runInContext(context, { timeout: 50 });
  if (typeof result !== 'string' || Buffer.byteLength(result) > 4096) throw new Error();
  parentPort.postMessage(result);
} catch { parentPort.postMessage(null); }
`;

/** Additional checks cannot grant an unassigned/disabled tool or rewrite its arguments. */
export async function checkToolPermission(source: string | undefined, input: ToolPermissionCheckInput) {
  if (source === undefined) return;
  if (activeWorkers >= maxWorkers) throw new HttpError(503, '权限检查繁忙，请稍后重试');
  validatePermissionScript(source);
  activeWorkers++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<unknown>(resolve => {
      worker = new Worker(workerSource, {
        eval: true, execArgv: [], env: {}, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 },
        workerData: { source: functionSource(source), input: JSON.stringify(input) },
      });
      worker.stdout?.resume(); worker.stderr?.resume();
      worker.once('message', value => {
        try { resolve(typeof value === 'string' ? JSON.parse(value) : undefined); }
        catch { resolve(undefined); }
      });
      worker.once('error', () => resolve(undefined));
      worker.once('exit', () => resolve(undefined));
      timer = setTimeout(() => resolve(undefined), 1000);
    });
    if (result === true) return;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const value = result as Record<string, unknown>;
      if (Object.keys(value).every(key => ['allow', 'reason'].includes(key)) && typeof value.allow === 'boolean' &&
          (value.reason === undefined || typeof value.reason === 'string')) {
        if (value.allow) return;
        if (typeof value.reason === 'string' && value.reason.trim())
          throw new HttpError(403, value.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000));
      }
    }
    throw new HttpError(403, '工具权限检查未通过');
  } finally {
    clearTimeout(timer);
    try { if (worker) await worker.terminate(); }
    finally { activeWorkers--; }
  }
}
