import { AppServerRpcError } from '../../packages/agentcore/src/index.mjs';
import { hasActiveSubmission, isDispatchable, phaseForRole } from '../../packages/workflow/src/state.js';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { SessionManager } from '../sessions/manager.js';
import type { SharedCoordinator, SharedLease } from '../infra/storage/coordination.js';
import { MemoryCoordinator } from '../infra/storage/coordination.js';
import { HttpError, redactCredentials } from '../../util/errors.js';
import { resultSchema, validatePlan, within, type Finding } from '../../packages/workflow/src/index.js';
import type { WorkflowAttempt, WorkflowJob, WorkflowRun } from '../../protocol/workflow-types.js';
import { publicRun, terminal, type StoredRun, type WorkflowStore } from './store.js';
import {
  canonical,
  designJobs,
  digest,
  job,
  outputSchema,
  promptFor,
  templateDigest,
  version,
} from './templates.js';
import type { WorkflowValidationRunner } from './validation.js';

class WorkflowPersistenceError extends HttpError {
  constructor(cause: unknown) {
    super(
      cause instanceof HttpError ? cause.status : 503,
      cause instanceof HttpError ? cause.message : '工作流状态提交结果未知，将重新读取持久化记录'
    );
    this.cause = cause;
  }
}

type Manager = Pick<
  SessionManager,
  'readProject' | 'ensureWorkflowSession' | 'prepareWorkflowThread' | 'submitWorkflowTurn' | 'read' | 'stop'
>;
type Validator = Pick<WorkflowValidationRunner, 'fingerprint' | 'startValidation' | 'observe'>;
export type Action = {
  kind:
    | 'approve'
    | 'reject'
    | 'request-changes'
    | 'revise'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'retry'
    | 'reconcile';
  expectedRevision: number;
  clientRequestId: string;
  reason?: string;
  jobId?: string;
  approvalId?: string;
  planId?: string;
  planHash?: string;
  approvalRevision?: number;
};
const last = (j: WorkflowJob) => j.attempts.at(-1);
const active = (a?: WorkflowAttempt) => hasActiveSubmission(a?.status);
const message = (e: unknown) => redactCredentials(e instanceof Error ? e.message : String(e)).slice(0, 1200);
const now = () => new Date().toISOString();
const conflict = (s: string): never => {
  throw new HttpError(409, s);
};
const jobs = (r: StoredRun) => r.jobs.filter((j) => j.version === r.version);
const canDispatch = (r: StoredRun) => isDispatchable(r.status);
const writable = (j: WorkflowJob) =>
  Boolean(j.spec?.ownedPaths.length) && (j.role === 'worker' || j.role === 'integration');

export class WorkflowService {
  private coordinator: SharedCoordinator;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closing = false;
  constructor(
    private store: WorkflowStore,
    private manager: Manager,
    private validation: Validator,
    private selectModel: () => Promise<{ model: string; modelEntryId?: string }>,
    coordinator?: SharedCoordinator,
    private log: (error: unknown) => void = console.error
  ) {
    this.coordinator = coordinator ?? new MemoryCoordinator();
  }

  start() {
    this.timer ??= setInterval(() => this.wake(), 2500);
    this.timer.unref();
    this.wake();
  }
  private wake() {
    if (this.closing || this.pending) return;
    this.pending = this.runPending()
      .catch(this.log)
      .finally(() => {
        this.pending = undefined;
      });
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.pending;
  }
  list(projectId?: string) {
    return this.store.list(projectId);
  }
  async get(id: string) {
    return publicRun(await this.require(id));
  }
  private async require(id: string) {
    const r = await this.store.get(id);
    if (!r) throw new HttpError(404, '工作流不存在');
    return r;
  }
  private async save(r: StoredRun, event: string) {
    const revision = r.revision++;
    r.updatedAt = now();
    r.events.push({ sequence: r.revision, at: r.updatedAt, message: event });
    try {
      await this.store.save(r, revision);
    } catch (error) {
      throw new WorkflowPersistenceError(error);
    }
  }
  async create(input: { projectId: string; requirement: string; parallelism: number; clientRequestId: string }) {
    const id = input.clientRequestId,
      createDigest = digest(canonical(input));
    const existing = await this.store.get(id);
    if (existing) {
      if (existing.createDigest !== createDigest) conflict('幂等键已用于其他请求');
      return { id, revision: 1 };
    }
    const p = await this.manager.readProject(input.projectId);
    if (p.status !== 'active' || p.executionMode !== 'sandbox' || p.sandbox?.status !== 'ready')
      conflict('请先打开项目并准备好 Sandbox');
    const selected = await this.selectModel();
    if (!selected.model) conflict('请先配置 Codex 模型');
    const at = now();
    const r: StoredRun = {
      id,
      projectId: p.id,
      boxId: p.sandbox!.id,
      workspace: p.workingDirectory,
      createDigest,
      requests: {},
      requirement: input.requirement,
      ...selected,
      parallelism: input.parallelism,
      templateVersion: version,
      templateDigest,
      status: 'designing',
      revision: 1,
      version: 1,
      discussionRound: 0,
      createdAt: at,
      updatedAt: at,
      jobs: [],
      plans: [],
      decisions: [],
      artifacts: [],
      events: [{ sequence: 1, at, message: '开始只读调查与设计' }],
    };
    r.jobs = designJobs(r, '');
    try {
      await this.store.insert(r);
    } catch (error) {
      if ((await this.store.get(id))?.createDigest !== createDigest) throw error;
    }
    return { id, revision: 1 };
  }
  async act(id: string, a: Action) {
    return this.coordinator.run('workflow:' + id, async () => {
      const r = await this.require(id),
        hash = digest(canonical(a)),
        receipt = r.requests[a.clientRequestId];
      if (receipt) {
        if (receipt.digest !== hash) conflict('同一幂等键的请求内容不同');
        return { id, revision: receipt.revision };
      }
      if (r.revision !== a.expectedRevision || terminal(r)) conflict('工作流已结束或版本已变化');
      const plan = r.plans.at(-1);
      const live = jobs(r).some((j) => active(last(j)));
      switch (a.kind) {
        case 'approve':
        case 'reject':
        case 'request-changes': {
          if (
            r.status !== 'awaiting_approval' ||
            !plan ||
            plan.id !== a.planId ||
            plan.hash !== a.planHash ||
            plan.approvalId !== a.approvalId ||
            plan.approvalRevision !== a.approvalRevision
          )
            throw new HttpError(409, '审批版本或 hash 已变化');
          r.decisions.push({
            id: a.clientRequestId,
            actor: 'operator',
            planId: plan.id,
            hash: plan.hash,
            decision: a.kind,
            reason: a.reason ?? '',
            at: now(),
          });
          plan.approvalRevision++;
          if (a.kind === 'approve') {
            r.approvedHash = plan.hash;
            r.status = 'executing';
            const execution = plan.plan.tasks.map((t) => ({ ...job(r, t.role, t.key, t.description), spec: t }));
            for (const j of execution)
              j.dependencies = j.spec.dependsOn.map((key) => execution.find((k) => k.key === key)!.id);
            r.jobs.push(...execution);
          } else this.revise(r, a.reason || '根据人工反馈重新设计');
          break;
        }
        case 'revise':
          if (live || r.wave?.length || r.status === 'cancelling' || !a.reason?.trim())
            conflict('需要修改意见，并须先确认所有活动任务和写入结果');
          this.revise(r, a.reason!);
          break;
        case 'pause':
          if (!canDispatch(r)) conflict('当前阶段无法暂停');
          r.pausedFrom = r.status;
          r.status = 'paused';
          break;
        case 'resume':
          if (r.status === 'awaiting_human' && a.reason?.trim()) this.addPlanJob(r, a.reason);
          else if (r.status === 'paused' && r.pausedFrom) {
            r.status = r.pausedFrom;
            delete r.pausedFrom;
          } else conflict('恢复需要已暂停的流程，或对重大分歧给出明确决定');
          break;
        case 'cancel':
          r.status = 'cancelling';
          break;
        case 'retry': {
          const j = jobs(r).find((x) => x.id === a.jobId);
          if (
            r.status !== 'blocked' ||
            !j ||
            last(j)?.status !== 'failed' ||
            live ||
            r.attention?.includes('ownership_conflict') ||
            jobs(r).some((other) => last(other)?.error?.includes('ownership_conflict'))
          )
            throw new HttpError(409, '只允许在旧尝试已明确结束后重试失败任务');
          // Preserve every failed attempt; a new ordinal gets a new session and marker.
          this.prepare(r, j, false);
          r.status = phaseForRole[j.role];
          delete r.attention;
          break;
        }
        case 'reconcile': {
          if (
            r.status === 'blocked' &&
            !jobs(r).some((j) => last(j)?.status === 'failed') &&
            !r.attention?.includes('ownership_conflict')
          ) {
            const pending = jobs(r).find((j) => last(j)?.status !== 'succeeded');
            r.status = pending ? phaseForRole[pending.role] : r.approvedHash ? 'verifying' : 'discussing';
            delete r.attention;
          }
          break;
        }
      }
      r.requests[a.clientRequestId] = { digest: hash, revision: r.revision + 1 };
      await this.save(r, '人工操作 ' + a.kind + (a.reason ? ' · ' + a.reason : ''));
      return { id, revision: r.revision };
    });
  }
  private revise(r: StoredRun, reason: string) {
    const previous = r.plans.find((p) => p.version === r.version);
    const findings = jobs(r).flatMap((j) => {
      const attempt = last(j);
      const artifact = r.artifacts.find((a) => a.id === attempt?.artifactId);
      return artifact &&
        'concerns' in artifact.value &&
        (artifact.value.needsDecision || attempt?.status === 'failed')
        ? [{ task: j.key, summary: artifact.value.summary, concerns: artifact.value.concerns }]
        : [];
    });
    const revisionInstructions = [reason, canonical({ previousPlan: previous?.plan, findings })].join('\n');
    delete r.approvedHash;
    delete r.attention;
    delete r.baseline;
    delete r.wave;
    r.templateDigest = templateDigest;
    r.templateVersion = version;
    r.version++;
    r.discussionRound = 0;
    r.status = 'designing';
    r.jobs.push(...designJobs(r, revisionInstructions));
  }
  private addPlanJob(r: StoredRun, decision: string) {
    const planner = job(
      r,
      'plan',
      'plan',
      '汇总全部方案、意见和人工决定。' + decision,
      jobs(r).map((j) => j.id)
    );
    planner.reuseSessionId = jobs(r)
      .find((j) => j.role === 'lead')
      ?.attempts.at(-1)?.sessionId;
    r.jobs.push(planner);
    r.status = 'discussing';
    delete r.attention;
  }
  private prepare(r: StoredRun, j: WorkflowJob, reuse = true) {
    const marker = randomUUID();
    j.attempts.push({
      id: marker,
      ordinal: j.attempts.length + 1,
      status: 'preparing',
      sessionId: (reuse && j.reuseSessionId) || randomUUID(),
      promptHash: digest(promptFor(r, j, marker)),
      planHash: j.spec ? r.approvedHash : undefined,
      startedAt: now(),
    });
  }
  async runPending() {
    const ids = await this.store.pending();
    // Keep a slow Box from monopolizing the worker and bound concurrent RPCs.
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(ids.length, 4) }, async () => {
        while (!this.closing && cursor < ids.length) {
          const id = ids[cursor++],
            lease = await this.coordinator.tryAcquire('workflow:' + id);
          if (!lease) continue;
          try {
            await this.advance(await this.require(id), lease);
          } catch (error) {
            this.log(error);
          } finally {
            await lease.release();
          }
        }
      })
    );
  }
  private async context(r: StoredRun) {
    const p = await this.manager.readProject(r.projectId);
    if (
      p.status !== 'active' ||
      p.sandbox?.id !== r.boxId ||
      p.sandbox.status !== 'ready' ||
      p.sandboxOperation?.status === 'running' ||
      p.workingDirectory !== r.workspace
    )
      throw Error('项目 Sandbox 不可用或身份已变化');
    return { boxId: r.boxId, workspace: p.workingDirectory };
  }
  private async advance(r: StoredRun, lease: SharedLease) {
    if (terminal(r)) return;
    const current = jobs(r);
    try {
      for (const j of current) {
        const a = last(j);
        if (!a || !['running', 'sending', 'unknown'].includes(a.status)) continue;
        await this.observe(r, j, a);
        if (r.status === 'cancelling' && a.status === 'running' && !a.stopRequestedAt) {
          a.stopRequestedAt = now();
          await this.save(r, '请求停止 ' + j.key);
          await this.manager.stop(a.sessionId);
        }
      }
      if (r.wave?.length && (r.status !== 'cancelling' || current.some((j) => active(last(j)))))
        await this.finishWave(r, lease);
      if (r.status === 'cancelling') {
        if (!current.some((j) => active(last(j)))) {
          delete r.wave;
          delete r.baseline;
          r.status = 'cancelled';
          await this.save(r, '已确认所有活动尝试结束');
        }
        return;
      }
      if (!canDispatch(r)) return;
      const failed = current.find((j) => last(j)?.status === 'failed');
      if (failed) throw Error(last(failed)!.error || '任务失败');
      if (
        r.wave?.length &&
        !current.some((j) => r.wave!.includes(j.id) && (!last(j) || last(j)?.status === 'preparing'))
      )
        return;
      const ready = current.filter(
        (j) =>
          (!last(j) || last(j)?.status === 'preparing') &&
          j.dependencies.every((id) => last(current.find((d) => d.id === id)!)?.status === 'succeeded')
      );
      const slots = r.parallelism - current.filter((j) => active(last(j))).length;
      if (ready.length && slots > 0) {
        const selected = ready.filter((j) => !r.wave || r.wave.includes(j.id)).slice(0, slots);
        if (!r.wave && selected.some((j) => j.spec)) {
          const ctx = await this.context(r);
          const baseline = await this.validation.fingerprint(
            ctx,
            selected.map((j) => ({ id: j.id, paths: j.spec!.ownedPaths, inspect: j.spec!.readPaths }))
          );
          r.wave = selected.map((j) => j.id);
          r.baseline = baseline;
          await this.save(r, '已记录任务开始前的工作区指纹');
        }
        for (const j of selected) {
          lease.assertHeld();
          await this.dispatch(r, j, lease);
        }
      } else if (current.every((j) => last(j)?.status === 'succeeded')) await this.nextPhase(r);
    } catch (error) {
      lease.assertHeld();
      if (error instanceof WorkflowPersistenceError) throw error;
      const detail = message(error);
      if (r.attention !== detail || (r.status !== 'blocked' && r.status !== 'cancelling')) {
        if (r.status !== 'cancelling') r.status = 'blocked';
        r.attention = detail;
        await this.save(r, detail);
      }
    }
  }
  private async dispatch(r: StoredRun, j: WorkflowJob, lease: SharedLease) {
    if (r.templateDigest !== templateDigest) throw Error('模板版本已变化，请修订计划');
    if (!canDispatch(r) || (j.spec && (!r.approvedHash || r.approvedHash !== r.plans.at(-1)?.hash)))
      throw Error('缺少当前计划审批');
    if (!last(j)) {
      this.prepare(r, j);
      await this.save(r, '准备任务 ' + j.key);
    }
    const a = last(j)!;
    const ownerJob = r.jobs.find((other) =>
      other.attempts.some((previous) => previous.sessionId === a.sessionId)
    )!;
    try {
      await this.context(r);
      const owner = { kind: 'workflow' as const, runId: r.id, taskId: ownerJob.id, writable: writable(j) };
      await this.manager.ensureWorkflowSession(
        a.sessionId,
        owner,
        r.projectId,
        '工作台 · ' + j.key,
        r.model,
        r.modelEntryId
      );
      a.threadId = await this.manager.prepareWorkflowThread(a.sessionId);
      const prompt = promptFor(r, j, a.id);
      if (digest(prompt) !== a.promptHash) throw Error('任务输入已变化');
      lease.assertHeld();
      a.status = 'sending';
      r.status = phaseForRole[j.role];
      await this.save(r, '提交 ' + j.key + ' 尝试 ' + a.ordinal);
      a.turnId = await this.manager.submitWorkflowTurn(
        a.sessionId,
        a.threadId,
        prompt,
        outputSchema(j.role),
        async () => {
          lease.assertHeld();
          if (!(await this.store.atRevision(r.id, r.revision))) throw Error('提交前审批或工作流状态已变化');
          lease.assertHeld();
        }
      );
      a.status = 'running';
      await this.save(r, '已接收 ' + j.key);
    } catch (error) {
      if (error instanceof WorkflowPersistenceError) throw error;
      lease.assertHeld();
      a.status =
        a.status === 'sending' &&
        !(error instanceof AppServerRpcError && [-32601, -32602].includes(error.rpc.code))
          ? 'unknown'
          : 'failed';
      a.error = message(error);
      await this.save(r, j.key + ' · ' + a.error);
      if (a.status === 'failed') throw error;
    }
  }
  private async observe(r: StoredRun, j: WorkflowJob, a: WorkflowAttempt) {
    const session = await this.manager.read(a.sessionId);
    if (session.historyError) throw Error(session.historyError);
    if (session.threadId !== a.threadId) throw Error('任务线程身份不匹配');
    const candidates = session.turns.filter((t) =>
      a.turnId
        ? t.id === a.turnId || t.nativeTurnId === a.turnId
        : t.prompt.includes('[workflow-attempt ' + a.id + ']') && digest(t.prompt) === a.promptHash
    );
    if (candidates.length > 1) {
      a.status = 'unknown';
      a.error = '同一提交匹配了多个原生轮次，需要人工核对';
      throw Error(a.error);
    }
    if (!candidates.length) {
      if (a.status !== 'unknown') {
        a.status = 'unknown';
        a.error = '未唯一匹配原生提交，将继续观察';
        await this.save(r, j.key + ' · ' + a.error);
      }
      return;
    }
    const t = candidates[0];
    a.turnId = t.nativeTurnId ?? t.id;
    const firstObservation = !a.nativeStartedAt;
    a.nativeStartedAt = t.startedAt;
    if (t.completedAt) a.nativeCompletedAt = t.completedAt;
    if (t.status === 'running' || t.status === 'idle') {
      if (a.status !== 'running' || firstObservation) {
        a.status = 'running';
        delete a.error;
        await this.save(r, '已匹配原生轮次 ' + j.key);
      }
      return;
    }
    try {
      if (t.status !== 'completed') throw Error(t.error || '原生任务结束状态 ' + t.status);
      const changes = t.items.flatMap((i) => (i.type === 'file_change' ? i.changes.map((c) => c.path) : []));
      if (
        changes.some(
          (path) =>
            !(j.spec?.ownedPaths ?? []).some((root) =>
              within(
                posix.relative(
                  session.settings.workingDirectory,
                  posix.resolve(session.settings.workingDirectory, path)
                ),
                root
              )
            )
        )
      )
        throw Error('ownership_conflict · ' + j.key + ' 越界写入');
      const text = t.items.filter((i) => i.type === 'agent_message').at(-1)?.text;
      if (!text) throw Error('缺少结构化结果');
      const parsed: unknown = JSON.parse(text);
      const value = j.role === 'plan' ? validatePlan(parsed) : resultSchema.parse(parsed);
      const artifact = {
        id: randomUUID(),
        sequence: r.revision + 1,
        jobId: j.id,
        attemptId: a.id,
        digest: digest(canonical(value)),
        value,
        createdAt: now(),
      };
      r.artifacts.push(artifact);
      a.artifactId = artifact.id;
      if (j.spec && (!(value as Finding).passed || (value as Finding).needsDecision))
        throw Error('任务要求人工处理：' + (value as Finding).summary);
      delete a.error;
      a.status = j.spec ? 'checking' : 'succeeded';
    } catch (error) {
      a.status = t.status === 'cancelled' && r.status === 'cancelling' ? 'cancelled' : 'failed';
      a.error = message(error);
    }
    await this.save(r, j.key + ' · ' + (a.error ?? a.status));
  }
  private async finishWave(r: StoredRun, lease: SharedLease) {
    const wave = r.wave!.map((id) => r.jobs.find((j) => j.id === id)!);
    if (wave.some((j) => ['running', 'unknown', 'sending'].includes(last(j)?.status ?? ''))) return;
    if (canDispatch(r) && wave.some((j) => !last(j) || last(j)?.status === 'preparing')) return;
    const ctx = await this.context(r);
    if (r.baseline) {
      const after = await this.validation.fingerprint(
        ctx,
        wave.map((j) => ({ id: j.id, paths: j.spec!.ownedPaths, inspect: j.spec!.readPaths }))
      );
      for (const j of wave) {
        const a = last(j);
        if (a) a.fingerprints = { before: r.baseline[j.id] ?? null, after: after[j.id] ?? null };
      }
      if (after.other !== r.baseline.other) {
        for (const j of wave)
          if (last(j)?.status === 'checking')
            Object.assign(last(j)!, { status: 'failed', error: 'ownership_conflict' });
        delete r.wave;
        delete r.baseline;
        throw Error('ownership_conflict · 工作区在任务声明范围以外发生变化');
      }
      delete r.baseline;
      await this.save(r, '已核对工作区变化范围');
    }
    for (const j of wave) {
      const a = last(j);
      if (a?.status !== 'checking') continue;
      const check = j.spec!.validation;
      if (!a.validation) {
        if (!r.approvedHash || r.approvedHash !== a.planHash || r.approvedHash !== r.plans.at(-1)?.hash)
          throw Error('验证所需的计划审批已变化');
        if (!canDispatch(r)) {
          if (r.status === 'blocked' && wave.some((other) => last(other)?.status === 'failed')) {
            a.status = 'failed';
            a.error = '同批任务失败，验证尚未提交';
            await this.save(r, '停止验证 ' + j.key);
            continue;
          }
          if (r.status === 'cancelling') {
            a.status = 'cancelled';
            await this.save(r, '取消尚未提交的验证 ' + j.key);
            continue;
          }
          return;
        }
        const before = await this.validation.fingerprint(ctx, [{ id: 'allowed', paths: check.outputPaths }]);
        a.validation = { ...check, status: 'running', before: before.other ?? '' };
        await this.save(r, '开始独立执行验证 ' + j.key);
        lease.assertHeld();
        try {
          a.validation.operationId = await this.validation.startValidation(ctx, check, async () => {
            if (!(await this.store.atRevision(r.id, r.revision))) throw Error('验证计划已变化');
            lease.assertHeld();
          });
        } catch (error) {
          a.validation.status = 'unknown';
          a.error = message(error);
        }
        await this.save(r, '验证操作 ' + (a.validation.operationId ?? '结果未知'));
        return;
      }
      if (!a.validation.operationId) {
        if (a.validation.status !== 'unknown') {
          a.validation.status = 'unknown';
          await this.save(r, '缺少验证执行标识 ' + j.key);
        }
        throw Error('验证提交结果未知，无法安全重跑 ' + j.key);
      }
      let result;
      try {
        result = await this.validation.observe(r.boxId, a.validation.operationId);
      } catch (error) {
        if (a.validation.status !== 'unknown') {
          a.validation.status = 'unknown';
          await this.save(r, '暂时无法确认验证结果 ' + j.key);
        }
        throw error;
      }
      if (!result) return;
      const after = await this.validation.fingerprint(ctx, [{ id: 'allowed', paths: check.outputPaths }]);
      const escaped = (after.other ?? '') !== a.validation.before;
      a.validation.exitCode = result.exitCode;
      const output = redactCredentials(result.stdout + '\n' + result.stderr);
      a.validation.output = output.slice(-6000);
      a.validation.outputTruncated = Boolean(result.truncated || output.length > 6000);
      a.status = result.exitCode === 0 && !escaped ? 'succeeded' : 'failed';
      a.validation.status = a.status;
      if (a.status === 'failed')
        a.error = escaped ? 'ownership_conflict · 验证写入了未声明路径' : '验证失败，退出码 ' + result.exitCode;
      await this.save(r, j.key + ' · ' + (a.error ?? '验证通过'));
      if (a.error) throw Error(a.error);
    }
    delete r.wave;
    await this.save(r, '本批任务已结束');
  }
  private async nextPhase(r: StoredRun) {
    const current = jobs(r);
    if (current.some((j) => j.role === 'verifier')) {
      r.status = 'completed';
      await this.save(r, '集成与最终独立验证通过');
      return;
    }
    const planner = current.find((j) => j.role === 'plan');
    if (planner) {
      const artifact = r.artifacts.find((a) => a.id === last(planner)?.artifactId)!;
      const plan = validatePlan(artifact.value);
      r.plans.push({
        id: randomUUID(),
        version: r.version,
        hash: digest(canonical({ plan, templateDigest, version: r.version })),
        approvalId: randomUUID(),
        approvalRevision: 1,
        artifactId: artifact.id,
        plan,
      });
      r.status = 'awaiting_approval';
      await this.save(r, '已冻结计划，等待人工审批');
      return;
    }
    const reviewers = current.filter((j) => j.role === 'review');
    const prior = current.filter(
      (j) => j.role === 'discussion' && j.key.startsWith('round-' + r.discussionRound + '-')
    );
    const unresolved = prior.some(
      (j) => (r.artifacts.find((a) => a.id === last(j)?.artifactId)?.value as Finding)?.needsDecision
    );
    if (prior.length && !unresolved) this.addPlanJob(r, '');
    else if (r.discussionRound >= 2) {
      r.status = 'awaiting_human';
      r.attention = '两轮讨论后仍有重大分歧，请记录人工决定';
    } else {
      r.discussionRound++;
      r.status = 'discussing';
      for (const [i, review] of reviewers.entries()) {
        const d = job(
          r,
          'discussion',
          `round-${r.discussionRound}-${i}`,
          '交叉复核冻结意见和重大分歧',
          [...reviewers, ...prior].map((x) => x.id)
        );
        d.reuseSessionId = last(review)!.sessionId;
        r.jobs.push(d);
      }
    }
    await this.save(r, r.attention ?? '进入 ' + r.status);
  }
}
