import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

const MAX_BYTES = 64 * 1024 * 1024;
const text = content => typeof content === 'string' ? content : (Array.isArray(content) ? content.map(part => part.text ?? '').join('\n') : '');
const usage = value => Object.fromEntries(['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].map(key => [key, Number(value?.[key] ?? 0)]));

/** Project only Codex's persisted events; platform submissions are never inputs. */
export function parseNativeHistory(source) {
  const turns = [], byId = new Map(), confirmed = new Set(), responses = new Set();
  let current, model;
  const blocks = [], pendingOutputs = new Set();
  let firstOutput;
  const upsert = (turn, item, timestamp) => {
    const index = turn.items.findIndex(existing => existing.id === item.id);
    if (index < 0) turn.items.push(item); else turn.items[index] = item;
    turn.itemTimestamps[item.id] = timestamp;
  };
  for (const [index, line] of source.split('\n').entries()) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`Codex 会话记录第 ${index + 1} 行损坏`); }
    const p = record.payload ?? {}, timestamp = record.timestamp ?? new Date(0).toISOString();
    if (record.type === 'session_meta' && p.base_instructions?.text) blocks.push({ id: 'base', label: '基础指令', text: p.base_instructions.text });
    if (record.type === 'response_item') {
      const generated = (p.type === 'message' && p.role === 'assistant') || ['function_call', 'custom_tool_call', 'reasoning'].includes(p.type);
      // Retain only visible content; encrypted reasoning is not plaintext tokens.
      const visible = p.type === 'message' ? text(p.content)
        : p.type === 'reasoning' ? text(p.summary ?? p.content)
        : JSON.stringify(Object.fromEntries(['name', 'arguments', 'input', 'output'].filter(key => p[key] !== undefined).map(key => [key, p[key]])));
      const block = { id: `record-${record.ordinal ?? index}`, label: `${p.role ?? p.type} · ${visible.slice(0, 60)}`, text: visible, itemId: p.type === 'message' ? p.id ?? `native-item-${index}` : p.call_id ?? p.id ?? `native-item-${index}`, turnId: current?.id };
      if (generated) { firstOutput ??= blocks.length; pendingOutputs.add(block.id); }
      blocks.push(block);
    }
    if (record.type === 'turn_context') model = p.model ?? model;
    if (record.type === 'event_msg' && p.type === 'task_started') {
      current = byId.get(p.turn_id);
      if (!current) {
        current = { id: p.turn_id ?? `native-${index}`, prompt: '', images: [], status: 'running', codexAccepted: true, items: [], itemTimestamps: {}, startedAt: timestamp };
        turns.push(current); byId.set(current.id, current);
      }
      continue;
    }
    const turn = byId.get(p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id) ?? current;
    if (!turn) continue;
    if (record.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user' && !confirmed.has(turn.id)) {
        // Older rollouts have no UserMessage event. The last user item before
        // generation is the submission; preceding user items contain injected rules.
        turn.prompt = text(p.content);
      }
      if (p.type === 'message' && p.role === 'assistant') upsert(turn, { id: p.id ?? `native-item-${index}`, type: 'agent_message', text: text(p.content) }, timestamp);
      if (['function_call', 'custom_tool_call'].includes(p.type)) {
        let args = p.arguments ?? p.input;
        try { args = JSON.parse(args); } catch { /* Preserve exact non-JSON tool arguments. */ }
        upsert(turn, { id: p.call_id ?? p.id ?? `native-item-${index}`, type: 'mcp_tool_call', server: 'codex', tool: p.name ?? p.type, arguments: args, status: 'in_progress' }, timestamp);
      }
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        const item = turn.items.find(item => item.id === p.call_id);
        if (item) upsert(turn, { ...item, status: 'completed', result: { content: [{ type: 'text', text: typeof p.output === 'string' ? p.output : JSON.stringify(p.output) }], structured_content: p.output } }, timestamp);
      }
    }
    if (record.type === 'event_msg' && p.type === 'item_completed') {
      const item = p.item ?? {}, id = item.id ?? `native-item-${index}`;
      if (item.type === 'UserMessage') {
        turn.prompt = text(item.content);
        turn.images = (item.content ?? []).filter(part => part.type === 'local_image').map(part => part.path);
        confirmed.add(turn.id);
      } else if (item.type === 'AgentMessage') upsert(turn, { id, type: 'agent_message', text: text(item.content) }, timestamp);
      else if (item.type === 'Reasoning') {
        const summary = item.summary_text ?? item.summary ?? item.content;
        const summaryText = Array.isArray(summary) && summary.every(part => typeof part === 'string') ? summary.join('\n') : text(summary);
        if (summaryText) upsert(turn, { id, type: 'reasoning', text: summaryText }, timestamp);
      }
      else if (item.type === 'CommandExecution' || item.type === 'FileChange') {
        const toolName = item.type === 'CommandExecution' ? 'exec_command' : 'apply_patch';
        const fallback = turn.items.findIndex(existing => existing.type === 'mcp_tool_call' && existing.server === 'codex' && existing.tool.split('.').at(-1) === toolName);
        if (fallback >= 0) turn.items.splice(fallback, 1);
        if (item.type === 'CommandExecution') upsert(turn, {
          id, type: 'command_execution',
          command: Array.isArray(item.command) ? item.command.at(-1) ?? '' : item.command ?? '',
          aggregated_output: item.aggregated_output ?? `${item.stdout ?? ''}${item.stderr ?? ''}`,
          exit_code: item.exit_code, status: item.status === 'failed' ? 'failed' : 'completed',
        }, timestamp);
        else upsert(turn, {
          id, type: 'file_change', status: item.status === 'failed' ? 'failed' : 'completed',
          changes: Object.entries(item.changes ?? {}).map(([path, change]) => ({ path, kind: ['add', 'delete'].includes(change.type) ? change.type : 'update' })),
        }, timestamp);
      }
      else if (item.type === 'McpToolCall') upsert(turn, { ...item, type: 'mcp_tool_call' }, timestamp);
      else if (['agent_message', 'reasoning', 'command_execution', 'mcp_tool_call', 'file_change', 'web_search', 'todo_list', 'error'].includes(item.type)) upsert(turn, item, timestamp);
    }
    if (record.type === 'event_msg' && p.type === 'user_message') { turn.prompt = p.message ?? ''; confirmed.add(turn.id); }
    if (record.type === 'token_usage_record' && p.usage && !responses.has(p.response_id ?? `usage-${index}`)) {
      responses.add(p.response_id ?? `usage-${index}`);
      const u = usage(p.usage);
      // Tool results may be journaled before usage: they belong to the NEXT input.
      const inputEnd = firstOutput ?? blocks.length;
      const blockTexts = blocks.flatMap((block, position) => position < inputEnd
        ? [{ ...block, direction: 'input' }] : pendingOutputs.has(block.id) ? [{ ...block, direction: 'output' }] : []);
      firstOutput = undefined; pendingOutputs.clear();
      turn.contextUsage ??= [];
      turn.contextUsage.push({ source: 'rollout', outputItemIds: blockTexts.filter(block => block.direction === 'output').map(block => block.itemId).filter(Boolean), blockTexts, responseId: p.response_id, model, rawUsage: p.usage, inputTokens: u.input_tokens, cachedInputTokens: u.cached_input_tokens, outputTokens: u.output_tokens, observedAt: timestamp });
      turn.usage = usage(Object.fromEntries(Object.keys(u).map(key => [key, (turn.usage?.[key] ?? 0) + u[key]])));
    }
    if (record.type === 'event_msg' && ['task_complete', 'turn_aborted', 'task_failed'].includes(p.type)) {
      turn.status = p.type === 'task_complete' ? 'completed' : p.type === 'turn_aborted' ? 'cancelled' : 'failed';
      turn.completedAt = timestamp;
      if (p.type === 'task_failed') turn.error = p.message ?? p.error ?? 'Codex 任务失败';
      if (p.last_agent_message && !turn.items.some(item => item.type === 'agent_message' && item.text === p.last_agent_message)) upsert(turn, { id: `native-final-${turn.id}`, type: 'agent_message', text: p.last_agent_message }, timestamp);
    }
  }
  return turns.filter(turn => turn.prompt || confirmed.has(turn.id));
}

export async function readNativeHistory(threadId, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  if (!threadId) return [];
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(threadId)) throw new Error('Codex thread ID 格式错误');
  let visited = 0;
  async function visit(directory, depth) {
    if (++visited > 10000) throw new Error('Codex 会话目录超过读取限制');
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) if (entry.isFile() && (entry.name === `${threadId}.jsonl` || entry.name.endsWith(`-${threadId}.jsonl`))) return join(directory, entry.name);
    if (!depth) return;
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) if (entry.isDirectory()) {
      const found = await visit(join(directory, entry.name), depth - 1);
      if (found) return found;
    }
  }
  for (const name of ['sessions', 'archived_sessions']) {
    const root = join(codexHome, name);
    try {
      const expected = join(await realpath(codexHome), name);
      if (await realpath(root) !== expected) continue;
      const path = await visit(root, 4);
      if (!path) continue;
      if (!(await realpath(path)).startsWith(expected + sep)) throw new Error('Codex 会话路径无效');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await realpath(`/proc/self/fd/${file.fd}`)).startsWith(expected + sep)) throw new Error('Codex 会话路径无效');
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Codex 会话记录超过 64 MB 读取限制');
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const end = buffer.subarray(0, offset).lastIndexOf(10);
        if (end < 0) return [];
        const source = buffer.subarray(0, end + 1).toString('utf8');
        const metadata = JSON.parse(source.slice(0, source.indexOf('\n')));
        if (metadata.type !== 'session_meta' || metadata.payload?.id !== threadId) throw new Error('Codex 会话记录与 thread 不匹配');
        return parseNativeHistory(source);
      } finally { await file.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('找不到 Codex 原生会话记录');
}
