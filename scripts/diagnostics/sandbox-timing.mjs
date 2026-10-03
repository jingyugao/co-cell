#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compactResource, compactEvent, observePod, compactRuntimeRecord, analyzeCapture, runtimeOperations, renderReport } from './sandbox-timing-model.mjs';

const help = `只读 Sandbox 耗时诊断；不会创建/恢复/修改任何资源。

pnpm sandbox:timing --context <context> [--namespace cell-box] [--box box-…]
pnpm sandbox:timing --context <context> --watch --duration 180 --interval 1 --output tmp/sandbox-timing.json
pnpm sandbox:timing --input tmp/sandbox-timing.json [--json]

--watch             在 UI 操作前启动，保留 Pod 消失前的数据和 gate 放行时间范围
--duration <秒>     采集时长，默认 180；Ctrl-C 会保存已采集数据
--interval <秒>     采样间隔，默认 1；误差还包含 kubectl 请求延迟
--runtime-log <文件> 可重复，读取 CoCell runtime JSONL（含新增的阶段计时）
--output <文件>     保存可离线重放的 JSON，只保留诊断字段，不保存 Pod env/argv/CR 注解
--json              输出结构化报告

历史事件可能已过期；缺失阶段显示未知。Ready 历史抖动及重启不能仅凭当前 Pod 还原。
CoCell 的阶段计时需要运行包含本次改动的服务，日志默认在 data/logs/。`;

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' }, context: { type: 'string' }, namespace: { type: 'string', default: 'cell-box' },
    box: { type: 'string' }, watch: { type: 'boolean' }, duration: { type: 'string', default: '180' },
    interval: { type: 'string', default: '1' }, output: { type: 'string' }, input: { type: 'string' },
    json: { type: 'boolean' }, 'runtime-log': { type: 'string', multiple: true } } });
  if (values.help) { console.log(help); return; }
  const duration = Number(values.duration), interval = Number(values.interval);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400 || !Number.isFinite(interval) || interval < 0.25)
    throw new Error('duration 必须为 (0, 86400] 秒，interval 必须 ≥ 0.25 秒。');
  if (values.input && values.watch) throw new Error('--input 不能与 --watch 同用。');
  if (!values.input && !values.context) throw new Error('请显式指定 --context，或用 --input 分析已有采样。');
  const run = promisify(execFile);
  async function kube(args, namespaced = true) {
    const { stdout } = await run('kubectl', ['--context', values.context, '--request-timeout=10s',
      ...(namespaced ? ['--namespace', values.namespace] : []), ...args, '-o', 'json'],
    { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  let capture = values.input ? JSON.parse(await readFile(values.input, 'utf8')) : {
    schemaVersion: 1, context: values.context, namespace: values.namespace, cellboxes: [], pods: [], events: [],
    observations: {}, runtimeRecords: [], warnings: [] };
  if (capture.schemaVersion !== 1 || !Array.isArray(capture.cellboxes) || !Array.isArray(capture.pods) || !Array.isArray(capture.events))
    throw new Error('不是受支持的 sandbox:timing 采样文件。');
  capture.warnings ??= [];
  let stopped = false;
  const controller = new AbortController();
  const stop = () => { stopped = true; controller.abort(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  async function loadRuntime() {
    if (!values['runtime-log']) return;
    const records = [];
    for (const file of values['runtime-log']) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try { const r = compactRuntimeRecord(JSON.parse(line)); if (r) records.push(r); }
        catch { if (index !== lines.length - 1 && index !== lines.length - 2) capture.warnings.push(`${file}:${index + 1} 无效 JSONL。`); }
      }
    }
    capture.runtimeRecords = records.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }
  async function save() {
    if (!values.output) return;
    await mkdir(dirname(values.output), { recursive: true });
    const temporary = `${values.output}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(capture, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, values.output);
  }
  const start = Date.now();
  try {
    do {
      if (!values.input) {
        const results = await Promise.allSettled([
          kube(['get', 'cellboxes.cellbox.local']), kube(['get', 'pods']), kube(['get', 'events'])
        ]);
        if (results[0].status === 'rejected' || results[1].status === 'rejected')
          throw new Error('无法读取 Cellbox/Pod，请检查 context、namespace 和读取权限。', { cause: results.find(r => r.status === 'rejected').reason });
        const capturedAt = new Date().toISOString();
        const cellboxes = results[0].value.items.map(item => compactResource({ ...item, kind: 'Cellbox' }))
          .filter(cr => !values.box || cr.boxId === values.box || cr.name === values.box);
        const owners = new Set([...capture.cellboxes, ...cellboxes].map(cr => cr.uid));
        const pods = results[1].value.items.map(item => compactResource({ ...item, kind: 'Pod' })).filter(p => owners.has(p.ownerUID));
        const merge = (before, next, key) => [...new Map([...before, ...next].map(item => [item[key], item])).values()];
        capture.cellboxes = merge(capture.cellboxes, cellboxes, 'uid');
        capture.pods = merge(capture.pods, pods, 'uid');
        for (const p of pods) capture.observations[p.uid] = observePod(capture.observations[p.uid], p, capturedAt);
        const podUIDs = new Set(capture.pods.map(p => p.uid));
        const podNames = new Set(capture.cellboxes.map(cr => cr.podName).filter(Boolean));
        if (results[2].status === 'fulfilled') {
          const events = results[2].value.items.map(compactEvent).filter(e => podUIDs.has(e.objectUID) || podNames.has(e.name));
          capture.events = merge(capture.events, events, 'uid');
        } else capture.warnings.push('Events 读取失败；仅使用 Pod condition，事件原因不可用。');
        capture.capturedAt = capturedAt;
      }
      await loadRuntime();
      capture.warnings = [...new Set(capture.warnings)];
      await save();
      if (values.watch) console.error(`[${capture.capturedAt}] 已采样 ${capture.cellboxes.length} Cellbox / ${capture.pods.length} Pod`);
      if (!values.watch || stopped || Date.now() - start >= duration * 1000) break;
      await delay(Math.min(interval * 1000, Math.max(0, duration * 1000 - (Date.now() - start))), undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    } while (!stopped);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    // Preserve earlier successful samples even if a later collection fails.
    if (capture.capturedAt) await save();
  }
  console.log(values.json ? JSON.stringify({ capturedAt: capture.capturedAt, reports: analyzeCapture(capture, values.box),
    operations: runtimeOperations(capture.runtimeRecords ?? [], values.box?.replace(/^cellbox-/, '')),
    runtimeStages: (capture.runtimeRecords ?? []).filter(r => r.event === 'sandbox.runtime_stage' && (!values.box || r.sandboxId === values.box.replace(/^cellbox-/, ''))),
    warnings: capture.warnings }, null, 2) : renderReport(capture, values.box));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
