export type MessageObservation = {
  sessionId: string;
  connectionId: string;
  direction: 'client' | 'server';
  message: Record<string, any>;
  request?: { id: string | number; method: string; params?: any };
  receivedAt: number;
};

export type MessageObserverOptions = {
  maxEvents?: number;
  maxBytes?: number;
};

const DEFAULT_MAX_EVENTS = 1024;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** Bounded, isolated dispatch that preserves message order within each relay. */
export function createMessageObservers(
  observe: (event: MessageObservation) => Promise<void> | void,
  onError: (error: unknown) => void,
  options: MessageObserverOptions = {},
) {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const tails = new Map<string, Promise<void>>();
  const tasks = new Set<Promise<void>>();
  let queuedEvents = 0;
  let queuedBytes = 0;
  let closed = false;

  function report(error: unknown) {
    try { onError(error); } catch { /* Observation reporting cannot affect the relay. */ }
  }

  function dispatch(event: MessageObservation, byteLength: number): boolean {
    if (closed) return false;
    if (queuedEvents >= maxEvents || queuedBytes + byteLength > maxBytes) {
      report(new Error('Native relay observation queue is full; an observation was dropped'));
      return false;
    }
    queuedEvents++;
    queuedBytes += byteLength;
    const previous = tails.get(event.connectionId) ?? Promise.resolve();
    const task = previous.then(async () => {
      try { await observe(event); }
      catch (error) { report(error); }
      finally { queuedEvents--; queuedBytes -= byteLength; }
    });
    tails.set(event.connectionId, task);
    tasks.add(task);
    void task.finally(() => {
      tasks.delete(task);
      if (tails.get(event.connectionId) === task) tails.delete(event.connectionId);
    });
    return true;
  }

  async function drain(timeoutMs: number): Promise<void> {
    const pending = [...tasks];
    if (!pending.length || timeoutMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async function close(timeoutMs: number): Promise<void> {
    closed = true;
    await drain(timeoutMs);
  }

  return { dispatch, drain, close };
}
