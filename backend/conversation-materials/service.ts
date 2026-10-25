import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ConversationMaterials } from '../../protocol/conversation-materials-types.js';
import type { MemoryFileContent } from '../../protocol/memory-types.js';
import { HttpError } from '../../util/errors.js';
import { MemoryCoordinator, type SharedCoordinator } from '../infra/storage/coordination.js';
import { prepareMaterials, prepareLiveMaterials, type IndexedMaterialEvent, type MaterialThread } from './materials.js';
import type { MaterialsRepository } from './repository.js';
import { readMaterialContent } from './content.js';

const VERSION = 1;
export interface MaterialSource { sessionId: string; threadId: string; sourceUpdatedAt: string; boxId: string }
export interface PeriodMaterial { path: string; content: string }

async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Source adapters stop here. Memory, reports and future consumers share these immutable artifacts. */
export class ConversationMaterialsService {
  private coordinator: SharedCoordinator;
  constructor(private deps: { repository: MaterialsRepository; directory: string; coordinator?: SharedCoordinator }) {
    this.coordinator = deps.coordinator ?? new MemoryCoordinator();
  }

  private key(source: MaterialSource) {
    return createHash('sha256').update(JSON.stringify([VERSION, source.sessionId, source.threadId, source.sourceUpdatedAt, source.boxId])).digest('hex');
  }
  private directory(id: string) {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid conversation material ID');
    return join(this.deps.directory, id);
  }
  async cached(source: MaterialSource) {
    const material = await this.deps.repository.find(this.key(source));
    if (!material?.complete || material.version !== VERSION) return undefined;
    try {
      const root = this.directory(material.id);
      const index = await lstat(join(root, 'events.jsonl'));
      if (!index.isFile() || index.size !== material.indexByteLength) return undefined;
      if (await fileHash(join(root, 'events.jsonl')) !== material.indexSha256) return undefined;
      for (const file of material.files) {
        if (!/^(?:main|agent-[1-9]\d*)\/\d{3,}\.md$/.test(file.path)) return undefined;
        const info = await lstat(join(root, file.path));
        if (!info.isFile() || info.size !== file.byteLength) return undefined;
        if (await fileHash(join(root, file.path)) !== file.sha256) return undefined;
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    return material;
  }
  get(id: string) { return this.deps.repository.get(id); }

  async archive(source: MaterialSource, archive: string, signal?: AbortSignal, validate?: () => Promise<void>) {
    return this.prepare(source, true, output => prepareMaterials(archive, output, source.threadId, signal), signal, validate);
  }
  async live(source: MaterialSource, threads: MaterialThread[], complete: boolean, signal?: AbortSignal, validate?: () => Promise<void>) {
    return this.prepare(source, complete, output => prepareLiveMaterials(threads, output, signal), signal, validate);
  }
  private async prepare(source: MaterialSource, complete: boolean, build: (output: string) => ReturnType<typeof prepareMaterials>, signal?: AbortSignal, validate?: () => Promise<void>) {
    const run = async () => {
      signal?.throwIfAborted();
      const cached = complete ? await this.cached(source) : undefined;
      if (cached) { await validate?.(); return cached; }
      await mkdir(this.deps.directory, { recursive: true, mode: 0o700 });
      const work = await mkdtemp(join(this.deps.directory, '.collect-'));
      const id = randomUUID();
      try {
        const prepared = await build(join(work, 'files'));
        signal?.throwIfAborted();
        const indexPath = join(work, 'files', 'events.jsonl');
        const indexSha256 = await fileHash(indexPath);
        const indexInfo = await lstat(indexPath);
        await validate?.();
        signal?.throwIfAborted();
        const material: ConversationMaterials = { id, sessionId: source.sessionId, threadId: source.threadId,
          sourceUpdatedAt: source.sourceUpdatedAt, sourceKey: complete ? this.key(source)
            : createHash('sha256').update(this.key(source) + id).digest('hex'),
          version: VERSION, complete, firstMessage: Array.from(prepared.firstMessage).slice(0, 1000).join(''),
          files: prepared.files, encryptedCount: prepared.encryptedCount, indexByteLength: indexInfo.size,
          indexSha256, createdAt: new Date().toISOString() };
        await rename(join(work, 'files'), this.directory(id));
        const winner = await this.deps.repository.insert(material);
        if (winner.id !== id) await rm(this.directory(id), { recursive: true, force: true });
        return winner;
      } finally { await rm(work, { recursive: true, force: true }); }
    };
    return this.coordinator.run(`materials:${this.key(source)}`, run);
  }

  async content(id: string, path: string, offset = 0): Promise<MemoryFileContent> {
    const material = await this.deps.repository.get(id);
    const file = material?.files.find(file => file.path === path);
    if (!file || !/^(?:main|agent-[1-9]\d*)\/\d{3,}\.md$/.test(path)) throw new HttpError(404, '材料文件不存在');
    return readMaterialContent(this.directory(id), path, offset, file.byteLength);
  }

  /** A compact summary is background, never a new accomplishment. Keep a task anchor across midnight. */
  async period(id: string, start: Date, end: Date, signal?: AbortSignal): Promise<PeriodMaterial[]> {
    const material = await this.deps.repository.get(id);
    if (!material) throw new HttpError(404, '对话材料不存在');
    const input = createReadStream(join(this.directory(id), 'events.jsonl'), { signal });
    const digest = createHash('sha256');
    input.on('data', chunk => digest.update(chunk));
    const lines = createInterface({ input, crlfDelay: Infinity });
    const background = new Map<string, { summary?: string; task?: string; prompt?: string; answer?: string }>();
    const parts = new Map<string, { heading: string; background: string; events: string[]; coarse: boolean }>();
    let bytes = 0;
    try {
      for await (const line of lines) {
        signal?.throwIfAborted();
        const event = JSON.parse(line) as IndexedMaterialEvent;
        if ((!Number.isFinite(event.atMs) || event.atMs <= 0) && event.text.trim())
          throw new Error('对话包含缺少有效时间的记录，无法可靠归入报告期间');
        const previous = background.get(event.threadId) ?? {};
        if (event.atMs > 0 && event.atMs < start.getTime()) {
          if (event.kind === 'compaction' && event.summary) previous.summary = event.summary;
          if (event.kind === 'message' && event.role === 'user') {
            previous.task ??= event.text;
            previous.prompt = event.text;
          }
          if (event.kind === 'message' && event.role === 'assistant') previous.answer = event.text;
          background.set(event.threadId, previous);
          continue;
        }
        if (event.atMs < start.getTime() || event.atMs >= end.getTime() || !event.atMs) continue;
        if (event.kind === 'compaction') { if (event.summary) previous.summary = event.summary; background.set(event.threadId, previous); continue; }
        if (!event.text.trim()) continue;
        const key = `${event.threadId}/${event.contextIndex}`;
        let part = parts.get(key);
        if (!part) {
          part = { heading: `# ${event.agentName} · 上下文 ${event.contextIndex}`,
            background: [...new Set([previous.summary, previous.task, previous.prompt, previous.answer].filter(Boolean))]
              .map(text => text!.slice(0, 4000)).join('\n\n'), events: [], coarse: false };
          parts.set(key, part);
        }
        const text = `时间：${new Date(event.atMs).toISOString()}\n\n${event.text}`;
        bytes += Buffer.byteLength(text);
        if (bytes > 64 * 1024 ** 2) throw new Error('单条对话的期间材料超过 64 MiB，未截断或提交');
        part.events.push(text);
        part.coarse ||= event.timePrecision === 'turn';
        if (event.kind === 'message' && event.role === 'user') {
          previous.task ??= event.text;
          previous.prompt = event.text;
        }
        if (event.kind === 'message' && event.role === 'assistant') previous.answer = event.text;
        background.set(event.threadId, previous);
      }
    } finally { lines.close(); input.destroy(); }
    if (digest.digest('hex') !== material.indexSha256) throw new Error('对话时间索引校验失败，未使用已变化的材料');
    return [...parts].map(([path, part]) => ({ path: `${path}.md`, content: [part.heading,
      part.coarse ? '部分消息缺少独立时间：任务发起按轮次开始时间，执行结果按轮次完成时间；进行中结果按采集时间归属，不据此认定已完成。' : '',
      part.background ? `## 此前背景（不计入本期成果）\n\n${part.background}` : '', ...part.events].filter(Boolean).join('\n\n') }));
  }
}
