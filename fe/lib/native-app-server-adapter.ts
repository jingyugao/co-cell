import type { ThreadItem, Usage } from '../../protocol/agent-protocol';
import type { AgentEvent } from '../../protocol/types';

type NativeNotification = { method: string; params?: Record<string, any> };
const emptyUsage = (): Usage => ({ input_tokens: 0, cached_input_tokens: 0,
  cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
const status = (value?: string) => value === 'inProgress' || value === 'in_progress' ? 'in_progress'
  : value === 'failed' || value === 'declined' ? 'failed' : 'completed';

/** Browser-safe subset of the App Server event adapter used by the runtime. */
export class NativeAppServerEventAdapter {
  private items = new Map<string, ThreadItem>();
  private usage = emptyUsage();
  seed(items: ThreadItem[]) { this.items = new Map(items.map(item => [item.id, structuredClone(item)])); }
  private convert(item: any): ThreadItem | undefined {
    const previous = this.items.get(item.id);
    switch (item.type) {
      case 'agentMessage': return { id: item.id, type: 'agent_message', text: item.text ?? (previous?.type === 'agent_message' ? previous.text : ''), ...(item.delivery ? { delivery: item.delivery } : {}), ...(item.questions ? { questions: item.questions } : {}) };
      case 'reasoning': return { id: item.id, type: 'reasoning', text: (item.summary?.length ? item.summary : item.content)?.join('\n') || (previous?.type === 'reasoning' ? previous.text : '') };
      case 'commandExecution': return { id: item.id, type: 'command_execution', command: item.command ?? '', aggregated_output: item.aggregatedOutput ?? (previous?.type === 'command_execution' ? previous.aggregated_output : ''), ...(item.exitCode != null ? { exit_code: item.exitCode } : {}), status: status(item.status) };
      case 'fileChange': return { id: item.id, type: 'file_change', changes: (item.changes ?? []).map((change: any) => ({ path: change.path, kind: typeof change.kind === 'string' ? change.kind : change.kind?.type })), status: item.status === 'failed' || item.status === 'declined' ? 'failed' : 'completed' };
      case 'mcpToolCall': return { id: item.id, type: 'mcp_tool_call', server: item.server ?? '', tool: item.tool ?? '', arguments: item.arguments, status: status(item.status), ...(item.result ? { result: { content: item.result.content ?? [], structured_content: item.result.structuredContent } } : {}), ...(item.error ? { error: item.error } : {}) };
      case 'webSearch': return { id: item.id, type: 'web_search', query: item.action?.query ?? item.query ?? '' };
      default: return undefined;
    }
  }
  accept({ method, params: p = {} }: NativeNotification): AgentEvent[] {
    if (method === 'turn/started') return [{ type: 'turn.started', turn_id: p.turn?.id }];
    if (method === 'thread/tokenUsage/updated') {
      const usage = (p.tokenUsage as any)?.last ?? {};
      this.usage = { ...emptyUsage(), input_tokens: usage.inputTokens ?? 0, cached_input_tokens: usage.cachedInputTokens ?? 0, cache_write_input_tokens: usage.cacheWriteInputTokens ?? 0, output_tokens: usage.outputTokens ?? 0, reasoning_output_tokens: usage.reasoningOutputTokens ?? 0 };
      return [];
    }
    if (method === 'turn/completed') {
      const turn = p.turn as any;
      if (turn?.status !== 'completed') return [{ type: 'turn.failed', ...(['interrupted', 'cancelled', 'canceled', 'aborted'].includes(turn?.status) ? { cancelled: true } : {}), error: { message: turn?.error?.message ?? `Turn ${turn?.status ?? 'failed'}` } }];
      return [{ type: 'turn.completed', usage: this.usage }];
    }
    if (method === 'error') return [{ type: 'error', message: (p.error as any)?.message ?? 'App Server error' }];
    if (method === 'turn/plan/updated') return [{ type: 'item.updated', item: { id: `${p.turnId}:plan`, type: 'todo_list', items: ((p.plan as any[]) ?? []).map(step => ({ text: step.step, completed: step.status === 'completed' })) } }];
    if (method === 'item/started' || method === 'item/completed') {
      if ((p.item as any)?.type === 'contextCompaction') return [{ type: method === 'item/started' ? 'item.started' : 'item.completed', item: { id: (p.item as any).id, type: 'context_compaction', status: method === 'item/started' ? 'in_progress' : 'completed' } }];
      const item = this.convert(p.item);
      if (!item) return [];
      this.items.set(item.id, item);
      return [{ type: method === 'item/started' ? 'item.started' : 'item.completed', item: structuredClone(item) }];
    }
    const item = this.items.get(String(p.itemId));
    if (!item) return [];
    if (method === 'item/agentMessage/delta' && item.type === 'agent_message') item.text += String(p.delta ?? '');
    else if ((method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') && item.type === 'reasoning') item.text += String(p.delta ?? '');
    else if (method === 'item/reasoning/summaryPartAdded' && item.type === 'reasoning') { if (item.text) item.text += '\n'; }
    else if (method === 'item/commandExecution/outputDelta' && item.type === 'command_execution') item.aggregated_output += String(p.delta ?? '');
    else return [];
    return [{ type: 'item.updated', item: structuredClone(item) }];
  }
}
