import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppServerReader } from './app-server-reader.js';
import { ContainerCodexRuntime } from './container-runtime.js';
import type { Session, Turn } from '../../protocol/types.js';

class NotificationStream {
  private queue: unknown[] = [];
  private waiting: Array<(result: IteratorResult<unknown>) => void> = [];
  private ended = false;
  [Symbol.asyncIterator]() { return this; }
  push(value: unknown) {
    const waiter = this.waiting.shift();
    if (waiter) waiter({ done: false, value });
    else this.queue.push(value);
  }
  drain() { return this.queue.splice(0); }
  async next(): Promise<IteratorResult<unknown>> {
    if (this.queue.length) return { done: false, value: this.queue.shift() };
    if (this.ended) return { done: true, value: undefined };
    return new Promise(resolve => this.waiting.push(resolve));
  }
  async return(): Promise<IteratorResult<unknown>> {
    this.ended = true;
    this.queue = [];
    for (const wake of this.waiting.splice(0)) wake({ done: true, value: undefined });
    return { done: true, value: undefined };
  }
}

test('native observer seeds history, emits only new deltas, and releases its lease on cancellation', async () => {
  const stream = new NotificationStream();
  const resumeCalls: unknown[] = [];
  const requestCalls: Array<[string, unknown]> = [];
  let releases = 0, closes = 0, interrupts = 0;
  let snapshots = 0;
  const client = {
    events: () => stream,
    async threadResume(params: unknown) { resumeCalls.push(params); },
    async request(method: string, params: unknown) {
      requestCalls.push([method, params]);
      if (snapshots++ === 0) {
        // The history read captured stale text; its response is delayed until
        // after this already-buffered delta crosses the read boundary.
        stream.push({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread', turnId: 'native-turn', itemId: 'answer', delta: ' world',
        } });
        return { data: [{ id: 'native-turn', status: 'inProgress', startedAt: 1,
          items: [{ type: 'agentMessage', id: 'answer', text: 'hello' }] }] };
      }
      return { data: [{ id: 'native-turn', status: 'inProgress', startedAt: 1,
        items: [{ type: 'agentMessage', id: 'answer', text: 'hello world' }] }] };
    },
    async turnInterrupt() { interrupts++; },
    async close() { closes++; },
  };
  const reader = {
    async acquire() { return { client, async release() { releases++; }, retire() {} }; },
    async close() { closes++; },
  } as unknown as AppServerReader;
  const runtime = new ContainerCodexRuntime({
    paths: { root: '/workspace/.cocell', runtime: '/workspace/.cocell/runtime', codexHome: '/workspace/.codex', node: '/usr/bin/node' },
    prepareRemote: async () => false,
    sandboxes: {} as any,
    provider: {} as any,
    apiKey: '',
    appServerReader: reader,
  });
  const turn: Turn = { id: 'web-turn', nativeTurnId: 'native-turn', codexAccepted: true,
    prompt: 'prompt', images: [], items: [], status: 'running', startedAt: new Date().toISOString() };
  const session: Session = { id: 'session', projectId: 'project', sandbox: { id: 'box', status: 'ready',
    template: 'default', workingDirectory: '/workspace', lastActiveAt: new Date().toISOString() } as Session['sandbox'],
    title: 'test', threadId: 'thread', status: 'running', startedAt: turn.startedAt, createdAt: turn.startedAt,
    updatedAt: turn.startedAt, archivedAt: null, turns: [turn], settings: { executionMode: 'sandbox',
      workingDirectory: '/workspace', model: 'test', modelReasoningEffort: 'low', sandboxMode: 'danger-full-access',
      webSearchMode: 'disabled', networkAccessEnabled: true } };

  const controller = new AbortController();
  const observations = runtime.observe(session, turn, controller.signal);
  const initial = await observations.next();
  assert.equal(initial.done, false);
  assert.equal(initial.value?.type, 'snapshot');
  if (initial.value?.type !== 'snapshot') assert.fail('initial native history snapshot was not emitted');
  assert.equal(initial.value.turn.items[0]?.type === 'agent_message' ? initial.value.turn.items[0].text : undefined, 'hello world');
  assert.deepEqual(resumeCalls, [{ threadId: 'thread', excludeTurns: true }]);
  assert.equal(requestCalls.length, 2, 'a notification crossing a stale history read requires a fresh snapshot');
  assert(requestCalls.every(([method, params]) => method === 'thread/turns/list'
    && JSON.stringify(params) === JSON.stringify({ threadId: 'thread', itemsView: 'full', limit: 1, sortDirection: 'desc' })));

  stream.push({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', turnId: 'native-turn', itemId: 'answer', delta: ' ignored' } });
  stream.push({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'other-turn', itemId: 'answer', delta: ' ignored' } });
  stream.push({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'native-turn', itemId: 'answer', delta: ' again' } });
  const delta = await observations.next();
  assert.equal(delta.done, false);
  assert.equal(delta.value?.type, 'event');
  if (delta.value?.type !== 'event' || delta.value.event.type !== 'item.updated') assert.fail('native delta was not emitted');
  assert.equal(delta.value.event.item.type === 'agent_message' ? delta.value.event.item.text : undefined, 'hello world again');

  controller.abort();
  await assert.rejects(observations.next(), /aborted/i);
  assert.equal(releases, 1, 'cancellation should release this observation lease');
  assert.equal(interrupts, 0, 'observing cancellation must not interrupt the native turn');
  assert.equal(closes, 0, 'cancellation must not close the shared App Server connection');
});
