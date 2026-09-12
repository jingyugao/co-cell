import type { Codex, Input, Thread, ThreadOptions } from '../../packages/agentcore/src/index.mjs';
import type { AgentEvent, Session, StreamMessage, Turn } from '../../protocol/types.js';
import { applyTurnEvent } from '../../util/session-events.js';
import { HttpError } from '../../util/errors.js';
import { TurnLaunchCancelled, TurnObserverDetached, TurnTerminationUnconfirmed, type E2BRuntime } from './e2b-runtime.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import type { RequestUserApproval } from '../../protocol/approval-types.js';

export type CodexClient = Pick<Codex, 'startThread' | 'resumeThread'>;

type TurnExecutionDependencies = {
  client: CodexClient;
  e2b?: E2BRuntime;
  logger?: RuntimeLog;
  save(): Promise<void>;
  publish(message: StreamMessage): void;
  snapshot(): Session;
  updateSandbox(sandbox: NonNullable<Session['sandbox']>): Promise<void>;
  requestApproval?: RequestUserApproval;
  closeApprovals?(): Promise<void>;
  detachApprovals?(): Promise<void>;
  recovering?: boolean;
};

/** Runs one turn and persists each event before publishing it to subscribers. */
export async function runTurn(session: Session, turn: Turn, controller: AbortController, dependencies: TurnExecutionDependencies) {
  const { client, e2b, logger, save, publish, snapshot, updateSandbox } = dependencies;
  let terminalFailure: string | undefined;
  let detached = false;
  const started = Date.now();
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    void logger?.write({ event, sessionId: session.id, projectId: session.projectId, turnId: turn.id,
      threadId: session.threadId, model: session.settings.model, runtime: session.settings.executionMode ?? 'local',
      sandboxId: session.sandbox?.id, status: turn.status, ...extra });
  };
  log('turn.started');
  try {
    const { model, executionMode, ...settings } = session.settings;
    const options: ThreadOptions = { ...settings, ...(model ? { model } : {}), approvalPolicy: 'never', skipGitRepoCheck: true };
    let events: AsyncGenerator<AgentEvent>;
    if (executionMode === 'e2b') {
      if (!e2b) throw new HttpError(503, 'E2B 未配置，无法运行此沙箱会话');
      const observe = dependencies.recovering ? e2b.recover.bind(e2b) : e2b.run.bind(e2b);
      events = observe(session, turn, controller.signal, sandbox => updateSandbox(sandbox), dependencies.requestApproval, save);
    } else {
      const thread: Thread = session.threadId ? client.resumeThread(session.threadId, options) : client.startThread(options);
      const input: Input = turn.images.length ? [{ type: 'text', text: turn.prompt }, ...turn.images.map(path => ({ type: 'local_image' as const, path }))] : turn.prompt;
      ({ events } = await thread.runStreamed(input, { signal: controller.signal }));
    }
    let terminal = Boolean(dependencies.recovering && (turn.status === 'completed' || turn.status === 'failed'));
    for await (const event of events) {
      // The CLI can emit the actual failure before throwing a generic nonzero
      // exit error. Only retain a terminal failure, never a recovered retry.
      if (event.type === 'turn.failed') terminalFailure = event.error.message.trim() ? event.error.message : undefined;
      else if (event.type === 'turn.started' || event.type === 'turn.completed') terminalFailure = undefined;
      if (event.type === 'thread.started') session.threadId = event.thread_id;
      if (event.type === 'runtime.context_usage') session.contextUsage = { ...event.contextUsage };
      Object.assign(turn, applyTurnEvent(turn, event));
      if (event.type === 'error') log('sdk.error', { error: event.message });
      else if (event.type === 'turn.failed') log('turn.failed', { error: event.error.message });
      else if (event.type === 'item.started' || event.type === 'item.completed') {
        const item = event.item;
        if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type)) log('tool.' + event.type.slice(5), {
          toolType: item.type, toolId: item.id, ...('status' in item ? { status: item.status } : {}),
          ...(item.type === 'command_execution' ? { exitCode: item.exit_code } : {}),
        });
      }
      if (event.type === 'turn.completed' || event.type === 'turn.failed') terminal = true;
      await save();
      publish({ type: 'sdk', turnId: turn.id, event });
    }
    if (!terminal) throw new Error(turn.error || 'Codex 事件流提前结束，未收到完成事件');
  } catch (error) {
    if (error instanceof TurnObserverDetached) {
      detached = true;
      if (error instanceof TurnTerminationUnconfirmed) turn.error = error.message;
    } else if (error instanceof TurnLaunchCancelled) {
      turn.status = 'cancelled';
      turn.error = '服务正在升级，本轮尚未启动 Codex，可重新发送消息。';
    } else {
      const cancelled = controller.signal.aborted || (turn.execution?.stopRequested && error instanceof DOMException && error.name === 'AbortError');
      turn.status = cancelled ? 'cancelled' : 'failed';
      if (!cancelled) turn.error = terminalFailure ?? (error instanceof Error ? error.message : String(error));
      else delete turn.error;
    }
  } finally {
    if (detached) {
      await dependencies.detachApprovals?.();
      turn.phase = 'recovering';
      if (turn.execution) turn.execution.state = 'detached';
      session.status = 'running';
      session.updatedAt = new Date().toISOString();
      log('turn.observer_detached', { durationMs: Date.now() - started });
      await save();
      publish({ type: 'state', session: snapshot() });
      return;
    }
    try { await dependencies.closeApprovals?.(); }
    catch (error) {
      turn.status = controller.signal.aborted ? 'cancelled' : 'failed';
      turn.error = error instanceof Error ? error.message : String(error);
    }
    if (controller.signal.aborted && turn.status === 'running') turn.status = 'cancelled';
    turn.completedAt = new Date().toISOString();
    delete turn.phase;
    delete turn.retry;
    if (turn.execution) turn.execution.state = 'terminal';
    session.status = turn.status;
    session.updatedAt = turn.completedAt;
    log('turn.finished', { status: turn.status, durationMs: Date.now() - started, error: turn.error });
    await save();
    publish({ type: 'state', session: snapshot() });
  }
}
