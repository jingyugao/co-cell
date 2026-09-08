import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const [mode, value, rawCursor] = process.argv.slice(2);
const home = '/home/user/.codex';
const maxBytes = 8 * 1024 * 1024;
async function raw() {
  const threadId = value || null, cursor = Number(rawCursor || 0);
  const page = { source: 'codex-rollout', threadId, availability: threadId ? 'missing' : 'pending', messages: [], nextCursor: cursor, hasMore: false, skippedLines: 0 };
  if (!threadId) return page;
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(threadId)) throw new Error('Codex thread ID 格式错误');
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('原始消息游标无效');
  async function visit(directory, depth) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) if (entry.isFile() && (entry.name === `${threadId}.jsonl` || entry.name.endsWith(`-${threadId}.jsonl`))) return join(directory, entry.name);
    if (depth === 0) return;
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (!entry.isDirectory()) continue;
      const found = await visit(join(directory, entry.name), depth - 1);
      if (found) return found;
    }
  }
  let path;
  for (const name of ['sessions', 'archived_sessions']) {
    try {
      const root = join(home, name);
      if (await realpath(root) !== root) continue;
      path = await visit(root, 4);
      if (path) break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!path) return page;
  const resolved = await realpath(path);
  if (!['sessions', 'archived_sessions'].some(name => resolved.startsWith(join(home, name) + sep))) throw new Error('会话记录路径无效');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await file.stat();
    const head = Buffer.alloc(Math.min(size, 1024 * 1024));
    await file.read(head, 0, head.length, 0);
    const end = head.indexOf(10);
    if (end < 0) {
      if (head.length === 1024 * 1024) throw new Error('Codex 会话头格式不受支持');
      return { ...page, availability: 'pending' };
    }
    const metadata = JSON.parse(head.subarray(0, end).toString('utf8'));
    if (metadata.type !== 'session_meta' || metadata.payload?.id !== threadId) throw new Error('会话记录与当前 Codex thread 不匹配');
    if (cursor > size) throw new Error('会话记录已重写，请重新加载原始消息');
    if (cursor > 0) {
      const previous = Buffer.alloc(1);
      await file.read(previous, 0, 1, cursor - 1);
      if (previous[0] !== 10) throw new Error('游标没有指向完整记录边界');
    }
    const buffer = Buffer.alloc(Math.min(maxBytes, size - cursor));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor);
    page.availability = 'available';
    let start = 0;
    const types = new Set(['custom_tool_call', 'function_call', 'custom_tool_call_output', 'function_call_output']);
    const fields = ['type', 'id', 'call_id', 'name', 'input', 'arguments', 'output', 'status'];
    while (start < bytesRead) {
      const end = buffer.subarray(0, bytesRead).indexOf(10, start);
      if (end < 0) break;
      const offset = cursor + start;
      const line = buffer.subarray(start, end).toString('utf8');
      start = end + 1;
      page.nextCursor = cursor + start;
      let record;
      try { record = JSON.parse(line); } catch { if (line.trim()) page.skippedLines++; continue; }
      if (record?.type !== 'response_item' || !types.has(record.payload?.type)) continue;
      const payload = Object.fromEntries(fields.filter(key => Object.hasOwn(record.payload, key)).map(key => [key, record.payload[key]]));
      const message = { id: String(offset), payload };
      if (typeof record.timestamp === 'string') message.timestamp = record.timestamp;
      page.messages.push(message);
      if (page.messages.length === 100) break;
    }
    if (page.nextCursor === cursor && bytesRead === maxBytes) throw new Error('单条原始记录超过 8 MB，无法在页面完整展示');
    page.hasMore = page.nextCursor < size && (page.messages.length === 100 || bytesRead === maxBytes);
    return page;
  } finally { await file.close(); }
}
async function changes() {
  const git = async args => (await exec('git', args, { cwd: value, maxBuffer: 2 * 1024 * 1024, timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' } })).stdout;
  try {
    const [status, branch] = await Promise.all([git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']), git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => 'detached HEAD')]);
    const records = status.split('\0'), files = [];
    for (let i = 0; i < records.length; i++) {
      if (!records[i]) continue;
      const code = records[i].slice(0, 2);
      files.push({ status: code.trim(), path: records[i].slice(3) });
      if (/[RC]/.test(code)) i++;
    }
    let diff;
    try { diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', '.']); }
    catch { diff = (await Promise.all([git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--', '.']), git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', '.'])])).join(''); }
    return { branch: branch.trim(), files, diff };
  } catch (error) { return { branch: '', files: [], diff: '', error: error.message }; }
}
try { process.stdout.write(JSON.stringify(await (mode === 'raw' ? raw() : changes())) + '\n'); }
catch (error) { process.stdout.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
