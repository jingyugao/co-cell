import { Worker } from 'node:worker_threads';
import type { Turn } from '../../shared/types.js';

/** CPU-heavy tokenization runs outside the HTTP/SSE event loop. */
export function estimateNativeBlocksAsync(turns: Turn[]): Promise<Turn[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./block-estimates-worker.mjs', import.meta.url), { workerData: turns });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('计费计算超时')); }, 60_000);
    worker.once('message', result => { clearTimeout(timer); resolve(result); void worker.terminate(); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('计费计算进程已退出')); });
  });
}
