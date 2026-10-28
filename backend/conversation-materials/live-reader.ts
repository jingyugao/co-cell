import { posix } from 'node:path';
import type { AppServerReader } from '../execution/app-server-reader.js';
import { parseNativeCompactions } from '../execution/native-history.mjs';
import type { CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import type { Session } from '../../protocol/types.js';
import type { MaterialThread } from './materials.js';

const PAGE_SIZE = 100;
const MAX_THREADS = 200;
const MAX_DATA_BYTES = 64 * 1024 * 1024;
const ACTIVE_TURN_STATUSES = new Set(['inProgress', 'running']);

type NativeThread = {
  id: string;
  createdAt?: number | string;
  agentNickname?: string;
  source?: { subAgent?: { thread_spawn?: { parent_thread_id?: string; agent_nickname?: string } } };
};
type Page<T> = { data: T[]; nextCursor?: string | null };
class MaterialLimitError extends Error {}

function responseBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('App Server returned a non-JSON conversation response');
  return Buffer.byteLength(json);
}

function addBytes(current: number, value: unknown): number {
  const total = current + responseBytes(value);
  if (total > MAX_DATA_BYTES) throw new MaterialLimitError(`Live conversation material exceeds the ${MAX_DATA_BYTES}-byte limit`);
  return total;
}

function pageData<T>(response: Page<T>, label: string): T[] {
  if (!response || !Array.isArray(response.data)) throw new Error(`App Server ${label} response is missing history data`);
  return response.data;
}

function createdAt(thread: NativeThread): number {
  if (typeof thread.createdAt === 'number' && Number.isFinite(thread.createdAt)) return thread.createdAt;
  if (typeof thread.createdAt === 'string') {
    const parsed = Date.parse(thread.createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function readPages<T>(
  client: CodexAppServerClient,
  method: string,
  params: Record<string, unknown>,
  label: string,
  addResponse: (value: unknown) => void,
): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const response: Page<T> = await client.request<Page<T>>(method, {
      ...params,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    addResponse(response);
    result.push(...pageData(response, label));
    const nextCursor: string | null = response.nextCursor ?? null;
    if (nextCursor && seen.has(nextCursor)) throw new Error(`App Server returned a repeated ${label} cursor`);
    if (nextCursor) seen.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return result;
}

/** Paginated history contains compaction markers; their readable text lives in the rollout. */
async function hydrateCompactions(client: CodexAppServerClient, threadId: string,
  turns: Array<Record<string, any>>, addResponse: (value: unknown) => void, signal?: AbortSignal): Promise<void> {
  const markers = turns.flatMap(turn => turn.items).map(entry => entry.item ?? entry)
    .filter(item => String(item.type).replaceAll('_', '').toLowerCase() === 'contextcompaction'
      && (!item.status || item.status === 'completed') && typeof item.id === 'string');
  if (!markers.length) return;
  try {
    const { thread } = await client.request('thread/read', { threadId, includeTurns: false });
    addResponse({ thread });
    const path = thread?.path;
    if (thread?.id !== threadId || typeof path !== 'string' || !posix.isAbsolute(path)
      || !posix.basename(path).endsWith(`${threadId}.jsonl`)) return;
    signal?.throwIfAborted();
    const result = await client.request('fs/readFile', { path });
    addResponse(result);
    if (typeof result.dataBase64 !== 'string' || result.dataBase64.length > Math.ceil(MAX_DATA_BYTES / 3) * 4) return;
    const bytes = Buffer.from(result.dataBase64, 'base64');
    if (bytes.length > MAX_DATA_BYTES) return;
    const source = bytes.toString('utf8');
    const metadata = JSON.parse(source.slice(0, source.indexOf('\n')));
    if (metadata.type !== 'session_meta' || metadata.payload?.id !== threadId) return;
    const compactions = parseNativeCompactions(source);
    for (const marker of markers) {
      // Match only completed items already observed in this history snapshot.
      // Segment numbers alone cannot safely join two independently read streams.
      const matches = compactions.filter(value => value.itemId === marker.id);
      if (matches.length !== 1) continue;
      const compacted = matches[0];
      if (compacted.summary) marker.summary = compacted.summary;
      if (Number.isFinite(Date.parse(compacted.timestamp))) marker.compactionTimestamp = compacted.timestamp;
    }
  } catch (error) {
    // A missing/unsupported rollout read must not discard the paginated raw
    // history. Report selection retains the original segment without a summary.
    signal?.throwIfAborted();
    if (error instanceof MaterialLimitError) throw error;
  }
}

/** Reads complete raw App Server histories for one live session and its descendants. */
export function readLiveMaterialThreads(
  reader: AppServerReader,
  session: Session,
  signal?: AbortSignal,
): Promise<{ threads: MaterialThread[]; complete: boolean }> {
  if (!session.sandbox?.id) throw new Error('Live conversation material requires a Sandbox');
  if (!session.threadId) throw new Error('Live conversation material requires a root App Server thread');
  const sandboxId = session.sandbox.id;
  const rootThreadId = session.threadId;

  return reader.read(sandboxId, async client => {
    let dataBytes = 0;
    const countBytes = (value: unknown) => { dataBytes = addBytes(dataBytes, value); };
    const threads = new Map<string, NativeThread>();
    for (const archived of [false, true]) {
      const found = await readPages<NativeThread>(client, 'thread/list', {
        ancestorThreadId: rootThreadId,
        sourceKinds: ['subAgentThreadSpawn'],
        useStateDbOnly: true,
        archived,
      }, 'thread list', countBytes);
      for (const thread of found) {
        if (!thread || typeof thread.id !== 'string' || !thread.id) throw new Error('App Server returned an invalid subagent thread');
        threads.set(thread.id, thread);
        if (threads.size + 1 > MAX_THREADS) throw new Error(`Live conversation material exceeds the ${MAX_THREADS}-thread limit`);
      }
    }

    // App Server filters by ancestor, but verify the source chain before reading
    // histories in case a server or its state database returns unrelated rows.
    const descendants = new Set([rootThreadId]);
    const childThreads: NativeThread[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of threads.values()) {
        if (descendants.has(thread.id)) continue;
        const parentId = thread.source?.subAgent?.thread_spawn?.parent_thread_id;
        if (!parentId || !descendants.has(parentId)) continue;
        descendants.add(thread.id);
        childThreads.push(thread);
        changed = true;
      }
    }
    childThreads.sort((left, right) => createdAt(left) - createdAt(right) || left.id.localeCompare(right.id));

    const orderedThreads: Array<{ id: string; path: string; name: string }> = [
      { id: rootThreadId, path: 'main', name: 'main' },
      ...childThreads.map((thread, index) => {
        const fallbackName = `agent-${index + 1}`;
        const spawn = thread.source?.subAgent?.thread_spawn;
        return { id: thread.id, path: fallbackName, name: spawn?.agent_nickname || thread.agentNickname || fallbackName };
      }),
    ];

    const materialThreads: MaterialThread[] = [];
    let hasActiveTurn = false;
    for (const thread of orderedThreads) {
      const turns = await readPages<Record<string, any>>(client, 'thread/turns/list', {
        threadId: thread.id,
        itemsView: 'full',
        sortDirection: 'asc',
      }, `turn history for ${thread.path}`, countBytes);
      if (!turns.length) throw new Error(`App Server returned no turn history for ${thread.path}`);
      for (const turn of turns) {
        if (!turn || typeof turn !== 'object' || !Array.isArray(turn.items))
          throw new Error(`App Server returned incomplete raw turn history for ${thread.path}`);
        if (ACTIVE_TURN_STATUSES.has(turn.status)) hasActiveTurn = true;
      }
      const originalBytes = responseBytes(turns);
      await hydrateCompactions(client, thread.id, turns, countBytes, signal);
      dataBytes += Math.max(0, responseBytes(turns) - originalBytes);
      if (dataBytes > MAX_DATA_BYTES) throw new Error(`Live conversation material exceeds the ${MAX_DATA_BYTES}-byte limit`);
      materialThreads.push({ ...thread, turns });
    }

    return { threads: materialThreads, complete: session.status !== 'running' && !hasActiveTurn };
  }, signal);
}
