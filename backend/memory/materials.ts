import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type { MemoryFile } from '../../protocol/memory-types.js';
import { extractMemoryArchive, listMemoryArchiveFiles, readMemoryJsonl } from './archive.js';
import { materialValue, questionReply, structuredValue } from './markdown.js';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MAX_COMPRESSED_BYTES = 18 * 1024 ** 3;
const secretText = /(?:\\?["']?)(?:authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|credential)(?:\\?["']?\s*[:=]\s*)(?:\\?["'](?:\\.|[^"'\\])*\\?["']|[^\s,;]+)/gi;
const ciphertext = /gAAAAA[A-Za-z0-9_+/=-]{40,}/g;
const sensitiveKey = /(?:authorization|access.?token|refresh.?token|api.?key|password|passwd|secret|credential)/i;
const runtimeKey = /^(?:call_?id|item_?id|turn_?id|thread_?id|client_?id|chunk_?id|session_?id|process_?id|questionItemId|internal_chat_message_metadata_passthrough|source_locator|rollout_ordinal)$/i;
const INTERNAL_CONTEXT_KINDS = /^(?:agents_md(?:\.|$)|environments?(?:\.|$))/i;

type FileInfo = Omit<MemoryFile, 'id'>;
type Thread = { id: string; path: string; name: string };
type EventKind = 'message' | 'tool_call' | 'tool_result' | 'question' | 'compaction' | 'collaboration';
type MaterialEvent = {
  threadId: string;
  eventId?: string;
  order: number;
  tieOrder: number;
  atMs: number;
  turnId?: string;
  kind: EventKind;
  data: Record<string, unknown>;
  role?: 'user' | 'assistant';
  callId?: string;
  encryptedCount?: number;
};
type CleanResult = { value: unknown; encrypted: number };

function checkAbort(signal?: AbortSignal): void { signal?.throwIfAborted(); }

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function plainText(content: unknown): { text: string; encrypted: number } {
  if (typeof content === 'string') return { text: content, encrypted: 0 };
  if (!Array.isArray(content)) return { text: '', encrypted: 0 };
  const parts: string[] = [];
  let encrypted = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const item = part as Record<string, unknown>;
    if (item.type === 'encrypted_content') {
      parts.push('（消息正文在本次导出中为加密内容，无法还原。）');
      encrypted++;
    } else if (typeof item.text === 'string') parts.push(item.text);
    else if (item.type && item.type !== 'image') parts.push(`（非文本内容：${String(item.type)}）`);
  }
  return { text: parts.join('\n'), encrypted };
}

function cleanText(value: string): CleanResult {
  let encrypted = 0;
  let text = value.replace(ciphertext, () => {
    encrypted++;
    return '（消息正文在本次导出中为加密内容，无法还原。）';
  });
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, '[凭据已隐藏]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[凭据已隐藏]');
  text = text.replace(/(https?:\/\/[^\s/@:]+:)[^\s/@]+(@)/g, '$1[凭据已隐藏]$2');
  text = text.replace(secretText, match => `${match.slice(0, match.search(/[:=]/) + 1)}[凭据已隐藏]`);
  text = text.replace(/\b(?:call|item|turn|thread|client|session|process)_[A-Za-z0-9_-]{6,}\b/gi, '[运行标识已省略]');
  return { value: text, encrypted };
}

function cleanValue(value: unknown, parseJson = false): CleanResult {
  if (typeof value === 'string') {
    if (parseJson) {
      const parsed = structuredValue(value);
      if (parsed && typeof parsed === 'object') {
        const cleaned = cleanValue(parsed, true);
        // Keep source JSON distinguishable from transport objects when rendering output.
        return { value: JSON.stringify(cleaned.value, null, 2), encrypted: cleaned.encrypted };
      }
    }
    return cleanText(value);
  }
  if (Array.isArray(value)) {
    let encrypted = 0;
    const result = value.map(item => {
      const cleaned = cleanValue(item, parseJson); encrypted += cleaned.encrypted; return cleaned.value;
    });
    return { value: result, encrypted };
  }
  if (!value || typeof value !== 'object') return { value, encrypted: 0 };
  if ((value as Record<string, unknown>).type === 'encrypted_content')
    return { value: '（消息正文在本次导出中为加密内容，无法还原。）', encrypted: 1 };
  let encrypted = 0;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (runtimeKey.test(key)) continue;
    if (sensitiveKey.test(key)) { output[key] = '[凭据已隐藏]'; continue; }
    const cleaned = cleanValue(item, parseJson && !/^(?:cmd|command|code|patch|diff)$/.test(key));
    output[key] = cleaned.value; encrypted += cleaned.encrypted;
  }
  return { value: output, encrypted };
}

function getText(item: Record<string, unknown>): { text: string; encrypted: number } {
  if (typeof item.text === 'string' && item.text) {
    const cleaned = cleanText(item.text);
    return { text: String(cleaned.value), encrypted: cleaned.encrypted };
  }
  const result = plainText(item.content);
  const cleaned = cleanText(result.text);
  return { text: String(cleaned.value), encrypted: result.encrypted + cleaned.encrypted };
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function roleForType(type: string, item: Record<string, unknown>): 'user' | 'assistant' | undefined {
  const normalized = type.toLowerCase().replaceAll('_', '');
  if (normalized === 'usermessage' || item.role === 'user') return 'user';
  if (normalized === 'agentmessage' || normalized === 'assistantmessage' || item.role === 'assistant') return 'assistant';
  return undefined;
}

function renderQuestion(item: Record<string, unknown>): Record<string, unknown> {
  const text = typeof item.text === 'string' ? item.text : '';
  return { prompt: text, questions: Array.isArray(item.questions) ? item.questions : [] };
}

function addEvent(db: DatabaseSync, event: MaterialEvent, encrypted = event.encryptedCount ?? 0): void {
  const body = JSON.stringify(event.data);
  const eventId = event.eventId || null;
  if (event.kind === 'compaction' && eventId) {
    const existing = db.prepare("SELECT id, data_json, source FROM events WHERE thread_id=? AND kind='compaction' AND event_id=? LIMIT 1")
      .get(event.threadId, eventId);
    if (existing) {
      const existingData = JSON.parse(String(existing.data_json)) as Record<string, unknown>;
      const incomingHasSummary = typeof event.data.summary === 'string' && Boolean(event.data.summary);
      const existingHasSummary = typeof existingData.summary === 'string' && Boolean(existingData.summary);
      if (incomingHasSummary && !existingHasSummary) {
        db.prepare('UPDATE events SET data_json=?, order_no=?, tie_order=?, at_ms=?, source=?, encrypted_count=MAX(encrypted_count,?) WHERE id=?')
          .run(body, event.order, event.tieOrder, event.atMs, String(event.data.source ?? ''), encrypted, Number(existing.id));
      }
      return;
    }
  } else if ((event.kind === 'tool_call' || event.kind === 'tool_result') && event.callId) {
    const existing = (eventId ? db.prepare('SELECT id,event_id,order_no,source FROM events WHERE thread_id=? AND kind=? AND event_id=? LIMIT 1')
      .get(event.threadId, event.kind, eventId) : undefined)
      ?? db.prepare('SELECT id,event_id,order_no,source FROM events WHERE thread_id=? AND kind=? AND call_id=? LIMIT 1')
        .get(event.threadId, event.kind, event.callId);
    if (existing) {
      if (event.data.source === 'rollout' && eventId && existing.event_id === eventId
        && Number(existing.order_no) === event.order && String(existing.source).startsWith('sqlite')) {
        db.prepare('UPDATE events SET raw_matched=1 WHERE id=?').run(Number(existing.id));
      }
      return;
    }
  } else if (eventId) {
    const existing = db.prepare('SELECT 1 FROM events WHERE thread_id=? AND event_id=? AND kind=? LIMIT 1')
      .get(event.threadId, eventId, event.kind);
    if (existing) return;
  }
  if (event.kind === 'message' && event.data.source === 'rollout' && typeof event.data.text === 'string') {
    const sqliteCopy = db.prepare(`SELECT id FROM events WHERE thread_id=? AND kind='message' AND role=? AND source LIKE 'sqlite%'
      AND raw_matched=0 AND json_extract(data_json,'$.text')=? ORDER BY order_no,tie_order,id LIMIT 1`)
      .get(event.threadId, event.role ?? null, event.data.text);
    if (sqliteCopy) {
      db.prepare('UPDATE events SET raw_matched=1 WHERE id=?').run(Number(sqliteCopy.id));
      return;
    }
  }
  db.prepare(`INSERT INTO events(thread_id,event_id,order_no,tie_order,at_ms,kind,role,call_id,data_json,source,encrypted_count,turn_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(event.threadId, eventId, event.order, event.tieOrder, event.atMs, event.kind, event.role ?? null,
      event.callId ?? null, body, String(event.data.source ?? ''), encrypted, event.turnId ?? null);
}

function isAutoInjected(item: Record<string, unknown>): boolean {
  const metadata = item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
  const kinds = Array.isArray(metadata?.content_item_kinds) ? metadata.content_item_kinds : [];
  return kinds.some(value => typeof value === 'string' && INTERNAL_CONTEXT_KINDS.test(value));
}

async function collectInjectedIds(path: string, thread: Thread, spool: DatabaseSync, signal?: AbortSignal): Promise<void> {
  for await (const record of readMemoryJsonl(path, signal)) {
    checkAbort(signal);
    if (record.type !== 'response_item') continue;
    const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
    if (!isAutoInjected(payload)) continue;
    for (const value of [payload.id, payload.client_id]) if (typeof value === 'string' && value)
      spool.prepare('INSERT OR IGNORE INTO injected(thread_id,event_id) VALUES(?,?)').run(thread.id, value);
  }
}

function threadFiles(dbPaths: string[], rootId: string): { threads: Thread[]; registeredThreadIds: Set<string> } {
  const parent = new Map<string, string>();
  const edges: Array<{ parent: string; child: string }> = [];
  const metadata = new Map<string, { path?: string; nickname?: string }>();
  const registeredThreadIds = new Set<string>();
  let foundEdges = false;
  for (const path of dbPaths.filter(path => /^state.*\.sqlite$/.test(basename(path)))) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (hasTable(db, 'thread_spawn_edges')) {
        foundEdges = true;
        for (const row of db.prepare('SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges ORDER BY parent_thread_id,child_thread_id').all())
          edges.push({ parent: String(row.parent_thread_id), child: String(row.child_thread_id) });
      }
      if (hasTable(db, 'threads')) {
        const names = columns(db, 'threads');
        const select = ['id', names.has('agent_path') ? 'agent_path' : "'' AS agent_path",
          names.has('agent_nickname') ? 'agent_nickname' : "'' AS agent_nickname"].join(',');
        for (const row of db.prepare(`SELECT ${select} FROM threads`).all()) {
          const id = String(row.id);
          registeredThreadIds.add(id);
          metadata.set(id, { path: String(row.agent_path ?? '') || undefined, nickname: String(row.agent_nickname ?? '') || undefined });
        }
      }
    } finally { db.close(); }
  }
  if (!foundEdges) throw new Error('The Cellbox export is missing thread_spawn_edges; child thread coverage cannot be verified');
  const ids = [rootId];
  for (let index = 0; index < ids.length; index++) {
    for (const edge of edges) if (edge.parent === ids[index] && !parent.has(edge.child) && edge.child !== rootId) {
      parent.set(edge.child, edge.parent);
      ids.push(edge.child);
    }
  }
  const threads = ids.map((id, index) => {
    const detail = metadata.get(id);
    const leaf = detail?.nickname || detail?.path?.split('/').filter(Boolean).at(-1) || `agent-${index}`;
    return { id, path: index ? `agent-${index}` : 'main',
      name: index ? leaf.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 80) : 'main' };
  });
  return { threads, registeredThreadIds };
}

function compactionInfo(payload: Record<string, unknown>, atMs: number, order: number, itemId?: string, source = 'rollout'): MaterialEvent {
  const rawSummary = typeof payload.message === 'string' ? payload.message
    : typeof payload.summary === 'string' ? payload.summary : '';
  let summary = rawSummary;
  let encryptedCount = 0;
  if (!summary && Array.isArray(payload.replacement_history)) {
    summary = payload.replacement_history.map(value => {
      if (!value || typeof value !== 'object') return '';
      const item = value as Record<string, unknown>;
      const role = item.role === 'user' ? '用户' : item.role === 'assistant' ? '助手' : '';
      if (!role || item.type !== 'message') return '';
      const content = plainText(item.content);
      encryptedCount += content.encrypted;
      return `${role}：${content.text}`;
    }).filter(Boolean).join('\n');
  }
  const cleaned = cleanText(summary);
  encryptedCount += cleaned.encrypted;
  const externalId = [payload.compaction_id, payload.item_id, payload.id, itemId].find(value => typeof value === 'string' && value) as string | undefined;
  return { threadId: '', ...(externalId ? { eventId: externalId } : {}), order, tieOrder: order, atMs,
    kind: 'compaction', encryptedCount,
    data: { summary: cleaned.value, source, summarySource: rawSummary ? 'message' : summary ? 'replacement_history_fallback' : 'none' } };
}

function messageEvent(threadId: string, item: Record<string, unknown>, itemType: string,
  eventId: string | undefined, order: number, atMs: number, source: string): { event?: MaterialEvent; encrypted: number } {
  const role = roleForType(item.type ? String(item.type) : itemType, item);
  if (!role || ['system', 'developer'].includes(String(item.role))) return { encrypted: 0 };
  const typed = String(item.type ?? itemType).toLowerCase().replaceAll('_', '');
  if (!['usermessage', 'agentmessage', 'assistantmessage', 'message'].includes(typed)) return { encrypted: 0 };
  const text = getText(item);
  if (!text.text.trim()) return { encrypted: text.encrypted };
  const asyncQuestion = role === 'assistant' && item.delivery === 'async';
  const data = asyncQuestion ? renderQuestion(item) : { text: text.text };
  const cleaned = cleanValue(data);
  return { event: { threadId, ...(eventId ? { eventId } : {}), order, tieOrder: order, atMs,
    kind: asyncQuestion ? 'question' : 'message', role, ...(asyncQuestion && typeof item.id === 'string' ? { callId: item.id } : {}),
    data: { ...cleaned.value as Record<string, unknown>, source } },
    encrypted: text.encrypted + cleaned.encrypted };
}

function isToolCall(type: string): boolean {
  return ['functioncall', 'customtoolcall', 'mcptoolcall', 'commandexecution', 'collabagenttoolcall']
    .includes(type.toLowerCase().replaceAll('_', ''));
}
function isToolResult(type: string): boolean {
  return ['functioncalloutput', 'customtoolcalloutput', 'toolresult', 'filechange']
    .includes(type.toLowerCase().replaceAll('_', ''));
}

function toolEvent(threadId: string, item: Record<string, unknown>, type: string, eventId: string | undefined,
  callId: string | undefined, order: number, atMs: number, source: string): { event?: MaterialEvent; encrypted: number } {
  const isCall = isToolCall(type), isResult = isToolResult(type);
  if (!isCall && !isResult) return { encrypted: 0 };
  const normalized = type.toLowerCase().replaceAll('_', '');
  const raw = normalized === 'commandexecution'
    ? { name: '命令执行', input: { command: item.command, cwd: item.cwd, actions: item.commandActions },
      output: item.aggregatedOutput ?? '', status: item.status, exitCode: item.exitCode }
    : normalized === 'filechange'
      ? { output: item.changes ?? '', status: item.status }
      : normalized === 'collabagenttoolcall'
        ? { name: item.tool ?? 'Agent 协作', input: { prompt: item.prompt, model: item.model, reasoningEffort: item.reasoningEffort },
          output: item.agentsStates ? Object.values(item.agentsStates as Record<string, unknown>) : '', status: item.status }
        : isCall ? { name: item.name ?? item.tool ?? type, input: item.arguments ?? item.input ?? item.params ?? '',
          ...(item.result === undefined ? {} : { output: item.result }), status: item.status }
          : { output: item.output ?? item.result ?? '', status: item.status };
  const cleaned = cleanValue(raw, true);
  return { event: { threadId, ...(eventId ? { eventId } : {}), order, tieOrder: order, atMs,
    kind: isCall ? 'tool_call' : 'tool_result', ...(callId ? { callId } : {}),
    data: { ...cleaned.value as Record<string, unknown>, source, nativeType: normalized } }, encrypted: cleaned.encrypted };
}

async function reconcileNativeToolEvents(db: DatabaseSync, threads: Thread[], signal?: AbortSignal): Promise<void> {
  const rawExec = db.prepare(`SELECT id,order_no,call_id,turn_id,data_json FROM events WHERE thread_id=? AND kind='tool_call'
    AND source='rollout' AND json_extract(data_json,'$.name')='exec' ORDER BY order_no,tie_order,id`);
  const rawResult = db.prepare(`SELECT order_no FROM events WHERE thread_id=? AND kind='tool_result' AND source='rollout'
    AND call_id=? AND turn_id=? ORDER BY order_no,tie_order,id LIMIT 1`);
  const native = db.prepare(`SELECT id,order_no,call_id,turn_id,data_json,source,raw_matched FROM events WHERE thread_id=?
    AND json_extract(data_json,'$.nativeType') IN ('commandexecution','filechange')
    ORDER BY order_no,tie_order,id`);
  const remove = db.prepare('DELETE FROM events WHERE id=?');
  const update = db.prepare('UPDATE events SET data_json=? WHERE id=?');
  let processed = 0;
  for (const thread of threads) {
    const rawCalls = rawExec.all(thread.id) as Array<Record<string, unknown>>;
    const sourceCalls = rawCalls.map(row => ({ id: Number(row.id), order_no: Number(row.order_no),
      call_id: row.call_id === null ? undefined : String(row.call_id),
      turn_id: row.turn_id === null ? undefined : String(row.turn_id),
      result_order: row.call_id && row.turn_id
        ? Number(rawResult.get(thread.id, String(row.call_id), String(row.turn_id))?.order_no ?? 0) : 0,
      data: JSON.parse(String(row.data_json)) as Record<string, unknown> }));
    for (const event of native.all(thread.id)) {
      if (++processed % 512 === 0) {
        checkAbort(signal);
        await new Promise<void>(resolve => setImmediate(resolve));
        checkAbort(signal);
      }
      if (event.source !== 'rollout' && Number(event.raw_matched) !== 1) continue;
      const data = JSON.parse(String(event.data_json)) as Record<string, unknown>;
      const order = Number(event.order_no);
      const turnId = event.turn_id === null ? undefined : String(event.turn_id);
      if (!turnId) continue;
      const enclosing = sourceCalls.filter(call => call.turn_id === turnId && call.call_id
        && call.order_no < order && order < call.result_order);
      if (enclosing.length !== 1) continue;
      const call = enclosing[0];
      if (data.nativeType === 'filechange') {
        const changes = call.data.nativeChanges;
        call.data.nativeChanges = changes === undefined ? data.output : Array.isArray(changes)
          ? [...changes, data.output] : [changes, data.output];
      } else {
        const executions = Array.isArray(call.data.nativeExecutions) ? call.data.nativeExecutions : [];
        executions.push({ input: data.input, output: data.output, status: data.status, exitCode: data.exitCode });
        call.data.nativeExecutions = executions;
      }
      update.run(JSON.stringify(call.data), Number(call.id));
      remove.run(Number(event.id));
    }
  }
}

async function collectRollout(path: string, thread: Thread, db: DatabaseSync, signal?: AbortSignal): Promise<void> {
  let ordinal = 0;
  let currentTurn = '';
  let checkedThreadMetadata = false;
  let pendingCompaction: { event: MaterialEvent; turn: string } | undefined;
  const flushCompaction = () => {
    if (!pendingCompaction) return;
    addEvent(db, pendingCompaction.event);
    pendingCompaction = undefined;
  };
  for await (const record of readMemoryJsonl(path, signal)) {
    checkAbort(signal);
    const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
    const atMs = timestamp(record.timestamp);
    const order = ordinal++;
    if (record.type === 'session_meta') {
      if (!checkedThreadMetadata) {
        checkedThreadMetadata = true;
        const metaId = String(payload.id ?? '');
        if (metaId !== thread.id) throw new Error(`Rollout thread metadata does not match its filename: ${basename(path)}`);
      }
      continue;
    }
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      const nextTurn = String(payload.turn_id ?? currentTurn);
      if (pendingCompaction && nextTurn !== pendingCompaction.turn) flushCompaction();
      currentTurn = nextTurn;
      continue;
    }
    const turn = String(payload.turn_id ?? currentTurn);
    const completedMarker = record.type === 'response_item' &&
      String(payload.type ?? '').toLowerCase().replaceAll('_', '') === 'contextcompaction' &&
      String(payload.status ?? '').toLowerCase() === 'completed' ? payload
      : record.type === 'event_msg' && payload.type === 'item_completed' && payload.item && typeof payload.item === 'object' &&
        String((payload.item as Record<string, unknown>).type ?? '').toLowerCase().replaceAll('_', '') === 'contextcompaction'
        ? payload.item as Record<string, unknown> : undefined;
    if (completedMarker) {
      const marker = compactionInfo(completedMarker, atMs, order, String(completedMarker.id ?? ''), 'rollout_marker');
      marker.threadId = thread.id;
      if (pendingCompaction && turn && turn === pendingCompaction.turn) {
        marker.data.summary = pendingCompaction.event.data.summary || marker.data.summary;
        marker.data.summarySource = pendingCompaction.event.data.summarySource || marker.data.summarySource;
        marker.encryptedCount = Math.max(marker.encryptedCount ?? 0, pendingCompaction.event.encryptedCount ?? 0);
        marker.data.source = 'rollout_compacted+rollout_marker';
        pendingCompaction = undefined;
      } else flushCompaction();
      addEvent(db, marker);
      continue;
    }
    const type = String(payload.type ?? '');
    const harmlessMeta = /^(?:world_state|turn_context|settings|thread_settings_applied|token_count|token_usage_record|rate_limits)$/i;
    const harmlessBetweenCompaction = record.type === 'session_meta' || harmlessMeta.test(String(record.type)) ||
      (record.type === 'event_msg' && harmlessMeta.test(type));
    if (pendingCompaction && (!harmlessBetweenCompaction || (turn && turn !== pendingCompaction.turn))) flushCompaction();
    if (record.type === 'compacted') {
      const marker = compactionInfo(payload, atMs, order, undefined, 'rollout_compacted');
      marker.threadId = thread.id;
      marker.turnId = turn || undefined;
      pendingCompaction = { event: marker, turn };
      const summary = typeof marker.data.summary === 'string' ? marker.data.summary : '';
      if (summary) db.prepare('INSERT INTO compaction_summaries(thread_id,turn_id,order_no,summary) VALUES(?,?,?,?)')
        .run(thread.id, turn || null, order, summary);
      continue;
    }
    if (record.type === 'response_item') {
      const type = String(payload.type ?? '');
      if (type === 'reasoning' || type === 'Reasoning') continue;
      if (type.toLowerCase().replaceAll('_', '') === 'contextcompaction') continue;
      if (['message', 'agent_message', 'agentMessage', 'AgentMessage'].includes(type)) {
        if ((type === 'message' && !['user', 'assistant'].includes(String(payload.role))) || isAutoInjected(payload)) continue;
        const parsed = messageEvent(thread.id, payload, type, String(payload.id ?? ''), order, atMs, 'rollout');
        if (parsed.event) {
          parsed.event.turnId = turn || undefined;
          if (parsed.event.role === 'assistant' && typeof payload.phase === 'string') parsed.event.data.phase = payload.phase;
          if (type !== 'message' && /^agent_?message$/i.test(type)) parsed.event.kind = 'collaboration';
          addEvent(db, parsed.event, parsed.encrypted);
        }
        continue;
      }
      if (isToolCall(type) || isToolResult(type)) {
        const id = String(payload.call_id ?? payload.id ?? '');
        if (isToolResult(type) && id && db.prepare("SELECT 1 FROM events WHERE thread_id=? AND kind='question' AND call_id=? LIMIT 1").get(thread.id, id)) continue;
        if (isToolCall(type) && payload.name === 'request_user_input_async' && id &&
          db.prepare("SELECT 1 FROM events WHERE thread_id=? AND kind='question' AND call_id=? LIMIT 1").get(thread.id, id)) continue;
        const parsed = toolEvent(thread.id, payload, type, String(payload.id ?? id), id, order, atMs, 'rollout');
        if (parsed.event) { parsed.event.turnId = turn || undefined; addEvent(db, parsed.event, parsed.encrypted); }
        continue;
      }
    }
    if (record.type === 'event_msg' && payload.type === 'item_completed') {
      const item = payload.item && typeof payload.item === 'object' ? payload.item as Record<string, unknown> : {};
      const type = String(item.type ?? '');
      if (type.toLowerCase().replaceAll('_', '') === 'contextcompaction') continue;
      else if (/reasoning/i.test(type)) continue;
      else if (isToolCall(type) || isToolResult(type)) {
        const id = String(item.call_id ?? item.id ?? '');
        if (isToolResult(type) && id && db.prepare("SELECT 1 FROM events WHERE thread_id=? AND kind='question' AND call_id=? LIMIT 1").get(thread.id, id)) continue;
        if (isToolCall(type) && item.name === 'request_user_input_async' && id &&
          db.prepare("SELECT 1 FROM events WHERE thread_id=? AND kind='question' AND call_id=? LIMIT 1").get(thread.id, id)) continue;
        const parsed = toolEvent(thread.id, item, type, String(item.id ?? id), id, order, atMs, 'rollout');
        if (parsed.event) { parsed.event.turnId = turn || undefined; addEvent(db, parsed.event, parsed.encrypted); }
      } else {
        const parsed = messageEvent(thread.id, item, type, String(item.id ?? ''), order, atMs, 'rollout');
        if (parsed.event) addEvent(db, parsed.event, parsed.encrypted);
      }
      continue;
    }
    if (record.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
      const parsed = messageEvent(thread.id, { type: 'message', role: 'user', content: payload.message }, 'message',
        String(payload.id ?? ''), order, atMs, 'rollout');
      if (parsed.event) addEvent(db, parsed.event, parsed.encrypted);
    }
  }
  flushCompaction();
  // Remove only a long raw-only final answer immediately preceding its compaction.
  // SQLite remains canonical, and intervening non-metadata events prevent removal.
  db.prepare(`DELETE FROM events AS candidate WHERE candidate.thread_id=? AND candidate.kind='message'
    AND candidate.role='assistant' AND candidate.source='rollout' AND candidate.turn_id IS NOT NULL
    AND json_extract(candidate.data_json,'$.phase')='final_answer' AND length(json_extract(candidate.data_json,'$.text'))>=256
    AND EXISTS (SELECT 1 FROM compaction_summaries AS summary WHERE summary.thread_id=candidate.thread_id
      AND summary.turn_id=candidate.turn_id AND summary.order_no>candidate.order_no
      AND instr(summary.summary,json_extract(candidate.data_json,'$.text'))>0
      AND NOT EXISTS (SELECT 1 FROM events AS between_event WHERE between_event.thread_id=candidate.thread_id
        AND between_event.order_no>candidate.order_no AND between_event.order_no<summary.order_no))`).run(thread.id);
}

async function readSqliteItems(path: string, threads: Map<string, Thread>, spool: DatabaseSync, sourceThreadIds: Set<string>, signal?: AbortSignal): Promise<void> {
  const source = new DatabaseSync(path, { readOnly: true });
  let rowsRead = 0;
  const yieldIfNeeded = () => ++rowsRead % 512 === 0;
  try {
    if (hasTable(source, 'thread_items')) {
    const cols = columns(source, 'thread_items');
    const required = ['thread_id', 'item_id', 'created_at_ms', 'item_json', 'item_type'];
    if (required.some(column => !cols.has(column))) throw new Error(`SQLite history schema is missing columns in ${basename(path)}`);
    const turn = cols.has('turn_id') ? 'turn_id' : "'' AS turn_id";
    const ordinal = cols.has('rollout_ordinal') ? 'rollout_ordinal' : 'created_at_ms';
    const injected = spool.prepare('SELECT 1 FROM injected WHERE thread_id=? AND event_id=?');
    const query = source.prepare(`SELECT thread_id,${turn},item_id,created_at_ms,item_json,item_type,${ordinal} AS source_order
      FROM thread_items ORDER BY created_at_ms,source_order,item_id`);
    for (const row of query.iterate()) {
      checkAbort(signal);
      if (yieldIfNeeded()) {
        checkAbort(signal);
        await new Promise<void>(resolve => setImmediate(resolve));
        checkAbort(signal);
      }
      const threadId = String(row.thread_id);
      sourceThreadIds.add(threadId);
      const thread = threads.get(threadId);
      if (!thread) continue;
      const raw = String(row.item_json);
      if (Buffer.byteLength(raw) > 16 * 1024 ** 2) throw new Error(`SQLite history item exceeds the size limit in ${basename(path)}`);
      let item: Record<string, unknown>;
      try { item = JSON.parse(raw) as Record<string, unknown>; }
      catch { throw new Error(`Malformed SQLite history item in ${basename(path)}`); }
      const itemType = String(item.type ?? row.item_type);
      const atMs = Number(row.created_at_ms), order = Number(row.source_order);
      const itemId = String(row.item_id);
      const clientId = typeof item.clientId === 'string' ? item.clientId : '';
      if (isAutoInjected(item) || [String(row.item_id), itemId, clientId].some(id => Boolean(id && injected.get(threadId, id)))) continue;
      if (itemType.toLowerCase().replaceAll('_', '') === 'contextcompaction') {
        const status = String(item.status ?? '').toLowerCase();
        if (status && status !== 'completed') continue;
        const marker = compactionInfo(item, atMs, order, itemId, 'sqlite_marker');
        marker.threadId = threadId;
        addEvent(spool, marker);
        continue;
      }
      if (/reasoning/i.test(itemType)) continue;
      const message = messageEvent(threadId, item, itemType, itemId, order, atMs, 'sqlite');
      if (message.event) { addEvent(spool, message.event, message.encrypted); continue; }
      const id = String(item.call_id ?? itemId);
      const tool = toolEvent(threadId, item, itemType, itemId, id, order, atMs, 'sqlite');
      if (tool.event) { tool.event.turnId = String(row.turn_id ?? '') || undefined; addEvent(spool, tool.event, tool.encrypted); }
    }
    }
    if (hasTable(source, 'thread_realtime_items')) {
      const realtimeCols = columns(source, 'thread_realtime_items');
      const requiredRealtime = ['thread_id', 'item_id', 'created_at_ms', 'item_type', 'item_json'];
      if (requiredRealtime.some(column => !realtimeCols.has(column))) throw new Error(`SQLite realtime schema is missing columns in ${basename(path)}`);
      const realtimeOrdinal = realtimeCols.has('rollout_ordinal') ? 'rollout_ordinal' : 'created_at_ms';
      const realtimeInjected = spool.prepare('SELECT 1 FROM injected WHERE thread_id=? AND event_id=?');
      for (const row of source.prepare(`SELECT thread_id,item_id,created_at_ms,item_type,item_json,${realtimeOrdinal} AS source_order
        FROM thread_realtime_items ORDER BY created_at_ms,source_order,item_id`).iterate()) {
        checkAbort(signal);
        if (yieldIfNeeded()) {
          checkAbort(signal);
          await new Promise<void>(resolve => setImmediate(resolve));
          checkAbort(signal);
        }
        const threadId = String(row.thread_id), thread = threads.get(threadId);
        sourceThreadIds.add(threadId);
        if (!thread) continue;
        let item: Record<string, unknown>;
        const raw = String(row.item_json);
        if (Buffer.byteLength(raw) > 16 * 1024 ** 2) throw new Error(`SQLite realtime item exceeds the size limit in ${basename(path)}`);
        try { item = JSON.parse(raw) as Record<string, unknown>; }
        catch { throw new Error(`Malformed SQLite realtime item in ${basename(path)}`); }
        const itemType = String(item.type ?? row.item_type), itemId = String(row.item_id);
        const clientId = typeof item.clientId === 'string' ? item.clientId : '';
        if (isAutoInjected(item) || /reasoning/i.test(itemType) || [String(row.item_id), itemId, clientId].some(id => Boolean(id && realtimeInjected.get(threadId, id)))) continue;
        if (itemType.toLowerCase().replaceAll('_', '') === 'contextcompaction') {
          const status = String(item.status ?? '').toLowerCase();
          if (status !== 'completed') continue;
          const marker = compactionInfo(item, Number(row.created_at_ms), Number(row.source_order), itemId, 'sqlite_marker');
          marker.threadId = threadId; addEvent(spool, marker); continue;
        }
        const message = messageEvent(threadId, item, itemType, itemId, Number(row.source_order), Number(row.created_at_ms), 'sqlite_realtime');
        if (message.event) { addEvent(spool, message.event, message.encrypted); continue; }
        const tool = toolEvent(threadId, item, itemType, itemId, String(item.call_id ?? itemId), Number(row.source_order), Number(row.created_at_ms), 'sqlite_realtime');
        if (tool.event) { tool.event.turnId = String(item.turn_id ?? '') || undefined; addEvent(spool, tool.event, tool.encrypted); }
      }
    }
  } finally { source.close(); }
}

function markdownValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（无内容）';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function eventMarkdown(kind: EventKind, role: string | null, data: Record<string, unknown>): string {
  if (kind === 'message') return `## ${role === 'user' ? '用户' : '助手'}\n\n${questionReply(markdownValue(data.text))}`;
  if (kind === 'question') {
    const questions = Array.isArray(data.questions) ? data.questions : [];
    return `## 助手向用户提问\n\n${markdownValue(data.prompt)}${questions.length ? `\n\n${materialValue(questions)}` : ''}`;
  }
  if (kind === 'collaboration') return `## Agent 消息\n\n${markdownValue(data.text)}`;
  if (kind === 'tool_call') return `## 工具：${markdownValue(data.name)}\n\n### 输入\n\n${materialValue(typeof data.input === 'string' ? structuredValue(data.input) : data.input) || '（无内容）'}` +
    `${data.output !== undefined ? `\n\n### 结果\n\n${materialValue(data.output) || '（无内容）'}` : ''}` +
    `${data.nativeExecutions !== undefined ? `\n\n### 原生执行记录\n\n${materialValue(data.nativeExecutions)}` : ''}` +
    `${data.nativeChanges !== undefined ? `\n\n### 文件变更\n\n${materialValue(data.nativeChanges)}` : ''}` +
    `${data.resultStatus !== undefined ? `\n\n结果状态：${markdownValue(data.resultStatus)}` : ''}` +
    `${data.status !== undefined ? `\n\n状态：${markdownValue(data.status)}` : ''}` +
    `${data.exitCode !== undefined ? `\n\n退出码：${markdownValue(data.exitCode)}` : ''}`;
  if (kind === 'tool_result') return `## 工具结果\n\n${materialValue(data.output) || '（无内容）'}${data.status !== undefined ? `\n\n状态：${markdownValue(data.status)}` : ''}`;
  return '';
}

type OpenMaterial = { file: FileInfo; stream: ReturnType<typeof createWriteStream>; hash: ReturnType<typeof createHash>;
  bytes: number; completion: Promise<void>; failure: { error?: unknown } };

async function openMaterial(outputDirectory: string, thread: Thread, contextIndex: number, summary?: string): Promise<OpenMaterial> {
  const relativePath = `${thread.path}/${String(contextIndex).padStart(3, '0')}.md`;
  const path = join(outputDirectory, relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const failure: { error?: unknown } = {};
  const completion = finished(output).catch(error => { failure.error = error; });
  const hash = createHash('sha256');
  let bytes = 0;
  const parts = [`# ${thread.name} · 上下文 ${contextIndex}`];
  if (summary) parts.push(`## 前文压缩摘要\n\n以下是此前对话的压缩摘要，仅作为本段背景，不是新的发言。\n\n${summary}`);
  for (const part of parts) {
    const text = `${part}\n\n`;
    const buffer = Buffer.from(text);
    hash.update(buffer); bytes += buffer.length;
    try {
      if (!output.write(buffer)) await once(output, 'drain');
      if (failure.error) throw failure.error;
    } catch (error) { output.destroy(); await completion; throw error; }
  }
  return { file: { path: relativePath, agentName: thread.name, contextIndex, byteLength: bytes, sha256: '' },
    stream: output, hash, bytes, completion, failure };
}

async function appendMaterial(file: OpenMaterial, text: string): Promise<void> {
  if (file.failure.error) throw file.failure.error;
  const buffer = Buffer.from(`${text}\n\n`);
  file.hash.update(buffer); file.bytes += buffer.length;
  if (!file.stream.write(buffer)) await once(file.stream, 'drain');
  if (file.failure.error) throw file.failure.error;
}

async function closeMaterial(file: OpenMaterial): Promise<FileInfo> {
  if (file.failure.error) throw file.failure.error;
  file.stream.end(); await file.completion;
  if (file.failure.error) throw file.failure.error;
  return { ...file.file, byteLength: file.bytes, sha256: file.hash.digest('hex') };
}

async function discardMaterial(file: OpenMaterial): Promise<void> {
  file.stream.destroy();
  await file.completion;
}

async function writeThreadMaterials(outputDirectory: string, thread: Thread, spool: DatabaseSync, encrypted: { count: number }, signal?: AbortSignal): Promise<FileInfo[]> {
  const query = spool.prepare(`SELECT id,order_no,tie_order,at_ms,kind,role,call_id,data_json,event_id,encrypted_count
    FROM events WHERE thread_id=? ORDER BY order_no,tie_order,id`);
  const callResults = spool.prepare("SELECT data_json FROM events WHERE thread_id=? AND kind='tool_result' AND call_id=? ORDER BY order_no,tie_order,id LIMIT 1");
  const pairedResults = new Set(spool.prepare(`SELECT DISTINCT result.call_id FROM events AS result
    JOIN events AS call ON call.thread_id=result.thread_id AND call.call_id=result.call_id AND call.kind='tool_call'
    WHERE result.thread_id=? AND result.kind='tool_result' AND result.call_id IS NOT NULL`).all(thread.id).map(row => String(row.call_id)));
  const files: FileInfo[] = [];
  let contextIndex = 1;
  let current = await openMaterial(outputDirectory, thread, contextIndex);
  try {
    for (const row of query.iterate(thread.id)) {
      checkAbort(signal);
      encrypted.count += Number(row.encrypted_count ?? 0);
      const kind = String(row.kind) as EventKind;
      const data = JSON.parse(String(row.data_json)) as Record<string, unknown>;
      if (kind === 'compaction') {
        files.push(await closeMaterial(current));
        contextIndex++;
        const summary = typeof data.summary === 'string' ? data.summary : '';
        current = await openMaterial(outputDirectory, thread, contextIndex, summary || '（压缩事件未保存可读摘要。）');
        continue;
      }
      if (kind === 'tool_result' && row.call_id && pairedResults.has(String(row.call_id))) continue;
      if (kind === 'tool_call' && row.call_id) {
        const result = callResults.get(thread.id, String(row.call_id));
        if (result) {
          const output = JSON.parse(String(result.data_json)) as Record<string, unknown>;
          data.output = output.output ?? output.result ?? '';
          if (output.status !== undefined) data.resultStatus = output.status;
        }
      }
      await appendMaterial(current, eventMarkdown(kind, row.role ? String(row.role) : null, data));
    }
    files.push(await closeMaterial(current));
  } catch (error) {
    await discardMaterial(current);
    throw error;
  }
  return files;
}

export async function prepareMaterials(archivePath: string, outputDirectory: string, rootThreadId: string, signal?: AbortSignal): Promise<{
  firstMessage: string;
  files: Array<Omit<MemoryFile, 'id'>>;
  encryptedCount: number;
}> {
  if (!UUID.test(rootThreadId)) throw new Error('Conversation thread ID is invalid');
  checkAbort(signal);
  const archive = await open(archivePath, 'r');
  try {
    const info = await archive.stat();
    if (!info.isFile() || info.size > MAX_COMPRESSED_BYTES) throw new Error('Conversation export exceeds the compressed size limit');
  } finally { await archive.close(); }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(outputDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Materials output must be a real directory');
  if ((await readdir(outputDirectory)).length) throw new Error('Materials output directory must be empty');
  const work = await mkdtemp(join(dirname(resolve(outputDirectory)), '.memory-materials-'));
  const extracted = join(work, 'codex');
  const spoolPath = join(work, 'materials.sqlite');
  const createdPaths: string[] = [];
  let spool: DatabaseSync | undefined;
  let encryptedCount = { count: 0 };
  try {
    await extractMemoryArchive(archivePath, extracted, signal);
    const { databases, rollouts } = await listMemoryArchiveFiles(extracted);
    if (!databases.some(path => /^state.*\.sqlite$/.test(basename(path))))
      throw new Error('Conversation export is missing state SQLite data');
    const { threads } = threadFiles(databases, rootThreadId);
    const sourceThreadIds = new Set<string>();
    const byId = new Map(threads.map(thread => [thread.id, thread]));
    spool = new DatabaseSync(spoolPath);
    spool.exec(`PRAGMA journal_mode=OFF;
      CREATE TABLE events(id INTEGER PRIMARY KEY,thread_id TEXT NOT NULL,event_id TEXT,order_no INTEGER NOT NULL,tie_order INTEGER NOT NULL,
        at_ms INTEGER NOT NULL,kind TEXT NOT NULL,role TEXT,call_id TEXT,data_json TEXT NOT NULL,source TEXT,encrypted_count INTEGER NOT NULL DEFAULT 0,
        raw_matched INTEGER NOT NULL DEFAULT 0,turn_id TEXT);
      CREATE TABLE compaction_summaries(thread_id TEXT NOT NULL,turn_id TEXT,order_no INTEGER NOT NULL,summary TEXT NOT NULL);
      CREATE TABLE injected(thread_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(thread_id,event_id));
      CREATE INDEX event_order ON events(thread_id,order_no,tie_order,id);
      CREATE INDEX event_id_lookup ON events(thread_id,event_id,kind);
      CREATE INDEX tool_result_lookup ON events(thread_id,call_id,kind,order_no);`);
    for (const path of rollouts) {
      const id = basename(path).match(/-([a-f\d-]{36})\.jsonl$/i)?.[1];
      const thread = id ? byId.get(id) : undefined;
      if (thread) { sourceThreadIds.add(thread.id); await collectInjectedIds(path, thread, spool, signal); }
    }
    for (const path of databases.filter(path => /^thread_history.*\.sqlite$/.test(basename(path))))
      await readSqliteItems(path, byId, spool, sourceThreadIds, signal);
    for (const path of rollouts) {
      const id = basename(path).match(/-([a-f\d-]{36})\.jsonl$/i)?.[1];
      const thread = id ? byId.get(id) : undefined;
      if (thread) await collectRollout(path, thread, spool, signal);
    }
    await reconcileNativeToolEvents(spool, threads, signal);
    for (const thread of threads) if (!sourceThreadIds.has(thread.id))
      throw new Error(`No conversation transcript source is available for ${thread.path}`);
    const outputFiles: FileInfo[] = [];
    let firstMessage = '';
    const first = spool.prepare("SELECT data_json FROM events WHERE thread_id=? AND kind='message' AND role='user' ORDER BY order_no,tie_order,id LIMIT 1");
    const rootRecord = first.get(rootThreadId);
    if (rootRecord) firstMessage = String((JSON.parse(String(rootRecord.data_json)) as Record<string, unknown>).text ?? '');
    for (const thread of threads) {
      checkAbort(signal);
      const files = await writeThreadMaterials(outputDirectory, thread, spool, encryptedCount, signal);
      outputFiles.push(...files);
      for (const file of files) createdPaths.push(join(outputDirectory, file.path));
    }
    return { firstMessage, files: outputFiles, encryptedCount: encryptedCount.count };
  } catch (error) {
    for (const path of createdPaths) await rm(path, { force: true }).catch(() => undefined);
    for (const entry of await readdir(outputDirectory).catch(() => []))
      await rm(join(outputDirectory, entry), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    spool?.close();
    await rm(work, { recursive: true, force: true });
  }
}
