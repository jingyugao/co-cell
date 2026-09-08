import { z } from 'zod';
import type { UserApproval, RequestUserApproval } from '../../shared/approval-types.js';
import type { Turn } from '../../shared/types.js';
import { HttpError } from '../core/errors.js';

const inputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  target: z.string().trim().min(1).max(2000),
  action: z.string().min(1).max(32_000).refine(value => value.trim().length > 0),
  impact: z.string().trim().min(1).max(8000),
}).strict();
export const approvalDecisionSchema = z.object({ decision: z.enum(['approved', 'rejected']) }).strict();
type Decision = z.infer<typeof approvalDecisionSchema>['decision'];
type Entry = {
  approval: UserApproval;
  signal: AbortSignal;
  finish(result: UserApproval): void;
  fail(error: unknown): void;
  cleanup(): void;
};

/** A turn owns its waiters; only the HTTP decision endpoint can approve them. */
export class ApprovalRequests {
  private entries = new Map<string, Entry>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private onAbort = () => { void this.close().catch(() => {}); };

  constructor(private turn: Turn, private signal: AbortSignal, private persistAndPublish: () => Promise<void>,
    private timeoutMs = 30 * 60_000) {
    signal.addEventListener('abort', this.onAbort, { once: true });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result;
    return result;
  }

  private unavailable(signal = this.signal) {
    return this.closed || this.signal.aborted || signal.aborted || this.turn.status !== 'running';
  }

  request: RequestUserApproval = async (requestId, input, signal) => {
    const id = z.string().uuid().parse(requestId);
    const body = inputSchema.parse(input);
    let finish!: Entry['finish'];
    let fail!: Entry['fail'];
    const result = new Promise<UserApproval>((resolve, reject) => { finish = resolve; fail = reject; });
    // Registration can fail before the caller starts awaiting this deferred result.
    void result.catch(() => {});
    await this.serialize(async () => {
      if (this.unavailable(signal)) throw new HttpError(409, '本轮执行已结束，不能请求确认');
      if (this.turn.approvals?.some(approval => approval.id === id)) throw new HttpError(409, '确认请求 ID 已使用');
      if (this.entries.size >= 8 || (this.turn.approvals?.length ?? 0) >= 20) throw new HttpError(409, '本轮确认请求过多');
      const approval: UserApproval = { ...body, id, status: 'pending', createdAt: new Date().toISOString() };
      const abort = () => { void this.serialize(() => this.settle(entry, 'cancelled')).catch(() => {}); };
      const timer = setTimeout(() => {
        void this.serialize(() => this.settle(entry, 'expired')).catch(() => {});
      }, this.timeoutMs);
      timer.unref();
      const entry: Entry = { approval, signal, finish, fail, cleanup: () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      } };
      signal.addEventListener('abort', abort, { once: true });
      this.entries.set(id, entry);
      (this.turn.approvals ??= []).push(approval);
      try { await this.persistAndPublish(); }
      catch (error) {
        approval.status = 'cancelled';
        approval.resolvedAt = new Date().toISOString();
        this.dispose(entry);
        fail(error);
        throw error;
      }
      if (this.unavailable(signal)) await this.settle(entry, 'cancelled');
    });
    return result;
  };

  async decide(id: string, decision: Decision): Promise<void> {
    await this.serialize(async () => {
      const approval = this.turn.approvals?.find(item => item.id === id);
      if (!approval) throw new HttpError(404, '确认请求不存在');
      if (approval.status === decision) return;
      if (approval.status !== 'pending') throw new HttpError(409, '此确认请求已处理或失效');
      const entry = this.entries.get(id);
      if (!entry || this.unavailable(entry.signal)) {
        if (entry) await this.settle(entry, 'cancelled');
        throw new HttpError(409, '本轮执行已结束，确认请求已失效');
      }
      if (Date.now() - Date.parse(approval.createdAt) >= this.timeoutMs) {
        await this.settle(entry, 'expired');
        throw new HttpError(409, '确认请求已过期，请重新发起');
      }
      await this.settle(entry, decision);
      if ((approval as UserApproval).status !== decision) throw new HttpError(409, '本轮执行已结束，确认请求已失效');
    });
  }

  private dispose(entry: Entry) {
    entry.cleanup();
    this.entries.delete(entry.approval.id);
  }

  private async settle(entry: Entry, status: Exclude<UserApproval['status'], 'pending'>): Promise<void> {
    if (!this.entries.has(entry.approval.id)) return;
    const approval = entry.approval;
    approval.status = status;
    approval.resolvedAt = new Date().toISOString();
    try {
      await this.persistAndPublish();
      // Stop/worker termination can happen while persistence is in flight.
      if (status === 'approved' && this.unavailable(entry.signal)) {
        approval.status = 'cancelled';
        approval.resolvedAt = new Date().toISOString();
        await this.persistAndPublish();
      }
      entry.finish(structuredClone(approval));
    } catch (error) {
      // A failed durable write must never release an approved result.
      approval.status = 'cancelled';
      approval.resolvedAt = new Date().toISOString();
      entry.fail(error);
      throw error;
    } finally { this.dispose(entry); }
  }

  close(): Promise<void> {
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    return this.serialize(async () => {
      const results = await Promise.allSettled([...this.entries.values()].map(entry => this.settle(entry, 'cancelled')));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
  }
}

/** Waiters cannot survive a server restart, regardless of the recorded turn status. */
export function cancelPersistedApprovals(turn: Turn): boolean {
  let changed = false;
  for (const approval of turn.approvals ?? []) {
    if (approval.status !== 'pending') continue;
    approval.status = 'cancelled';
    approval.resolvedAt = new Date().toISOString();
    changed = true;
  }
  return changed;
}
