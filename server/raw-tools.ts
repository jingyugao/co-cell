import { constants } from 'node:fs';
import { open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import type { RawToolMessage, RawToolPage, RawToolPayload } from '../shared/types.js';
import { HttpError } from './manager.js';

const TOOL_TYPES = new Set(['custom_tool_call', 'function_call', 'custom_tool_call_output', 'function_call_output']);
const TOOL_FIELDS = ['type', 'id', 'call_id', 'name', 'input', 'arguments', 'output', 'status'] as const;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 100;

export class RawToolReader {
  private paths = new Map<string, string>();
  constructor(private codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {}

  private async find(threadId: string): Promise<string | undefined> {
    // Do not follow directory symlinks or search arbitrary user-supplied paths.
    const visit = async (directory: string, depth: number): Promise<string | undefined> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name === `${threadId}.jsonl` || entry.name.endsWith(`-${threadId}.jsonl`))) return join(directory, entry.name);
      }
      if (depth === 0) return;
      for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
        if (!entry.isDirectory()) continue;
        const found = await visit(join(directory, entry.name), depth - 1);
        if (found) return found;
      }
    };
    for (const name of ['sessions', 'archived_sessions']) {
      try {
        const root = join(this.codexHome, name);
        // Only permit the actual sessions tree, not a replacement symlink to elsewhere.
        if (await realpath(root) !== join(await realpath(this.codexHome), name)) continue;
        const found = await visit(root, 4);
        if (found) { this.paths.set(threadId, found); return found; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async verify(file: FileHandle, threadId: string, size: number): Promise<boolean> {
    const head = Buffer.alloc(Math.min(size, 1024 * 1024));
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    const end = head.subarray(0, bytesRead).indexOf(10);
    if (end === -1) {
      if (size >= head.length && head.length === 1024 * 1024) throw new HttpError(422, 'Codex 会话头格式不受支持');
      return false;
    }
    let record;
    try { record = JSON.parse(head.subarray(0, end).toString('utf8')); }
    catch { throw new HttpError(422, 'Codex 会话记录头无法解析'); }
    if (record.type !== 'session_meta' || record.payload?.id !== threadId) throw new HttpError(409, '会话记录与当前 Codex thread 不匹配');
    return true;
  }

  async read(threadId: string | null, cursor = 0): Promise<RawToolPage> {
    const page: RawToolPage = {
      source: 'codex-rollout', threadId, availability: threadId ? 'missing' : 'pending',
      messages: [], nextCursor: cursor, hasMore: false, skippedLines: 0,
    };
    if (!threadId) return page;
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(threadId)) throw new HttpError(400, 'Codex thread ID 格式错误');
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, '原始消息游标无效');
    let path = this.paths.get(threadId) || await this.find(threadId);
    if (!path) return page;
    let file: FileHandle;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.paths.delete(threadId);
      path = await this.find(threadId);
      if (!path) return page;
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    try {
      const resolved = await realpath(path);
      const canonicalHome = await realpath(this.codexHome);
      const allowedRoots = ['sessions', 'archived_sessions'].map(name => join(canonicalHome, name) + sep);
      if (!allowedRoots.some(root => resolved.startsWith(root)) || !basename(path).endsWith(`${threadId}.jsonl`)) throw new HttpError(403, '会话记录路径无效');
      const { size } = await file.stat();
      if (!await this.verify(file, threadId, size)) return { ...page, availability: 'pending' };
      if (cursor > size) throw new HttpError(409, '会话记录已重写，请重新加载原始消息');
      // A cursor always points immediately after a newline; reject offsets inside JSON.
      if (cursor > 0) {
        const before = Buffer.alloc(1);
        await file.read(before, 0, 1, cursor - 1);
        if (before[0] !== 10) throw new HttpError(400, '游标没有指向完整记录边界');
      }
      const buffer = Buffer.alloc(Math.min(MAX_PAGE_BYTES, size - cursor));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor);
      page.availability = 'available';
      let start = 0;
      while (start < bytesRead) {
        const end = buffer.subarray(0, bytesRead).indexOf(10, start);
        if (end === -1) break; // Leave an unfinished tail for the next poll.
        const offset = cursor + start;
        const line = buffer.subarray(start, end).toString('utf8');
        start = end + 1;
        page.nextCursor = cursor + start;
        let record;
        try { record = JSON.parse(line); } catch { if (line.trim()) page.skippedLines++; continue; }
        if (record?.type !== 'response_item' || !TOOL_TYPES.has(record.payload?.type)) continue;
        // Return only actual tool message fields. Never expose reasoning, instructions,
        // ordinary chat messages or internal chat metadata from the same rollout.
        const payload = Object.fromEntries(TOOL_FIELDS.filter(key => Object.hasOwn(record.payload, key)).map(key => [key, record.payload[key]])) as RawToolPayload;
        const message: RawToolMessage = { id: String(offset), payload };
        if (typeof record.timestamp === 'string') message.timestamp = record.timestamp;
        page.messages.push(message);
        if (page.messages.length === MAX_MESSAGES) break;
      }
      if (page.nextCursor === cursor && bytesRead === MAX_PAGE_BYTES) throw new HttpError(413, '单条原始记录超过 8 MB，无法在页面完整展示');
      page.hasMore = page.nextCursor < size && (page.messages.length === MAX_MESSAGES || bytesRead === MAX_PAGE_BYTES);
      return page;
    } finally { await file.close(); }
  }
}
