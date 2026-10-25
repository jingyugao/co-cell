import type { AppServerReader } from '../execution/app-server-reader.js';
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

function responseBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('App Server returned a non-JSON conversation response');
  return Buffer.byteLength(json);
}

function addBytes(current: number, value: unknown): number {
  const total = current + responseBytes(value);
  if (total > MAX_DATA_BYTES) throw new Error(`Live conversation material exceeds the ${MAX_DATA_BYTES}-byte limit`);
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
      materialThreads.push({ ...thread, turns });
    }

    return { threads: materialThreads, complete: session.status !== 'running' && !hasActiveTurn };
  }, signal);
}
