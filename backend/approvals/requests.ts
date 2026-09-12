import { z } from 'zod';
import type { UserApproval, RequestUserApproval } from '../../protocol/approval-types.js';
import type { Turn } from '../../protocol/types.js';
import { HttpError } from '../../util/errors.js';

const inputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  target: z.string().trim().min(1).max(2000),
  action: z.string().min(1).max(32_000).refine(value => value.trim().length > 0),
  impact: z.string().trim().min(1).max(8000),
}).strict();
export const approvalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().trim().max(4_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === 'approved' && value.rejectionReason) {
    context.addIssue({ code: 'custom', message: '同意操作不能附带拒绝原因', path: ['rejectionReason'] });
  }
});
type Decision = z.infer<typeof approvalDecisionSchema>;
type Entry = {
  approval: UserApproval;
  result: Promise<UserApproval>;
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
  private detached = false;
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

  private ended(signal = this.signal) {
    return (this.closed && !this.detached) || this.signal.aborted || signal.aborted || this.turn.status !== 'running';
  }

  private register(approval: UserApproval, signal: AbortSignal): Entry {
    let finish!: Entry['finish'];
    let fail!: Entry['fail'];
    const result = new Promise<UserApproval>((resolve, reject) => { finish = resolve; fail = reject; });
    void result.catch(() => {});
    const abort = () => { void this.serialize(() => this.settle(entry, 'cancelled')).catch(() => {}); };
    const age = Math.max(0, Date.now() - Date.parse(approval.createdAt));
    const timer = setTimeout(() => {
      void this.serialize(() => this.settle(entry, 'expired')).catch(() => {});
    }, Math.max(0, this.timeoutMs - age));
    timer.unref();
    const entry: Entry = { approval, result, signal, finish, fail, cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    } };
    signal.addEventListener('abort', abort, { once: true });
    this.entries.set(approval.id, entry);
    return entry;
  }

  request: RequestUserApproval = async (requestId, input, signal) => {
    const id = z.string().uuid().parse(requestId);
    const body = inputSchema.parse(input);
    const { result } = await this.serialize(async () => {
      if (this.unavailable(signal)) throw new HttpError(409, '本轮执行已结束，不能请求确认');
      // Check inside the queue: replay and live delivery can arrive together.
      const existing = this.turn.approvals?.find(approval => approval.id === id);
      if (existing) {
        const same = existing.title === body.title && existing.target === body.target
          && existing.action === body.action && existing.impact === body.impact;
        if (!same) throw new HttpError(409, '确认请求 ID 已用于其他内容');
        const active = this.entries.get(id);
        if (active) return { result: active.result };
        if (existing.status !== 'pending') return { result: Promise.resolve(structuredClone(existing)) };
      }
      if (this.entries.size >= 8 || (!existing && (this.turn.approvals?.length ?? 0) >= 20)) throw new HttpError(409, '本轮确认请求过多');
      const approval: UserApproval = existing ?? { ...body, id, status: 'pending', createdAt: new Date().toISOString() };
      const entry = this.register(approval, signal);
      if (!existing) (this.turn.approvals ??= []).push(approval);
      try { if (!existing) await this.persistAndPublish(); }
      catch (error) {
        approval.status = 'cancelled';
        approval.resolvedAt = new Date().toISOString();
        this.dispose(entry);
        entry.fail(error);
        throw error;
      }
      if (this.ended(signal)) await this.settle(entry, 'cancelled');
      return { result: entry.result };
    });
    return result;
  };

  async decide(id: string, input: Decision): Promise<void> {
    const { decision, rejectionReason } = input;
    await this.serialize(async () => {
      const approval = this.turn.approvals?.find(item => item.id === id);
      if (!approval) throw new HttpError(404, '确认请求不存在');
      if (approval.status === decision) return;
      if (approval.status !== 'pending') throw new HttpError(409, '此确认请求已处理或失效');
      let entry = this.entries.get(id);
      if (this.unavailable(entry?.signal)) {
        if (entry && this.ended(entry.signal)) await this.settle(entry, 'cancelled');
        throw new HttpError(409, '本轮执行已结束，确认请求已失效');
      }
      // A recovered approval can be clicked before journal replay registers its waiter.
      entry ??= this.register(approval, this.signal);
      if (Date.now() - Date.parse(approval.createdAt) >= this.timeoutMs) {
        await this.settle(entry, 'expired');
        throw new HttpError(409, '确认请求已过期，请重新发起');
      }
      if (decision === 'rejected' && rejectionReason) approval.rejectionReason = rejectionReason;
      await this.settle(entry, decision);
      if ((approval as UserApproval).status !== decision) throw new HttpError(409, '本轮执行已结束，确认请求已失效');
    });
  }

  private dispose(entry: Entry) {
    entry.cleanup();
    this.entries.delete(entry.approval.id);
  }

  private async settle(entry: Entry, status: Exclude<UserApproval['status'], 'pending'>): Promise<void> {
    if (this.detached || this.entries.get(entry.approval.id) !== entry) return;
    const approval = entry.approval;
    approval.status = status;
    approval.resolvedAt = new Date().toISOString();
    try {
      await this.persistAndPublish();
      // Stop/worker termination can happen while persistence is in flight.
      if (status === 'approved' && this.ended(entry.signal)) {
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
    this.detached = false;
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    return this.serialize(async () => {
      const results = await Promise.allSettled([...this.entries.values()].map(entry => this.settle(entry, 'cancelled')));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      if (cancelPersistedApprovals(this.turn)) await this.persistAndPublish();
    });
  }

  /** Release this Web process's waiters without changing durable decisions. */
  detach(): Promise<void> {
    this.detached = true;
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    return this.serialize(async () => {
      for (const entry of [...this.entries.values()]) {
        this.dispose(entry);
        entry.fail(new Error('Web observer detached'));
      }
    });
  }
}

/** Cancel approvals only when their owning turn cannot be recovered. */
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
