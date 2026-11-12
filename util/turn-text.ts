import type { Turn } from '../protocol/types.js';
import type { ThreadItem } from '../protocol/agent-protocol.js';

/**
 * 从 turn 中提取可供长度估算的文本内容。
 * 包含 prompt 和所有 items 中的可读文本。
 */
export function extractTurnText(turn: Pick<Turn, 'prompt' | 'items'>): string {
  const parts: string[] = [turn.prompt];
  for (const item of turn.items) {
    parts.push(itemText(item));
  }
  return parts.join('\n');
}

/** 从单个 ThreadItem 中提取可读文本。 */
function itemText(item: ThreadItem): string {
  switch (item.type) {
    case 'agent_message':
    case 'reasoning':
      return item.text;
    case 'error':
      return item.message;
    case 'command_execution':
      return `${item.command}\n${item.aggregated_output}`;
    case 'mcp_tool_call':
      return `${item.server}/${item.tool}: ${JSON.stringify(item.arguments)}${item.result ? '\n' + JSON.stringify(item.result.content) : ''}${item.error ? '\nError: ' + item.error.message : ''}`;
    case 'file_change':
      return `File changes: ${item.changes.map((c: { kind: string; path: string }) => `${c.kind} ${c.path}`).join(', ')}`;
    case 'web_search':
      return `Search: ${item.query}`;
    case 'todo_list':
      return `Todo: ${item.items.map((t: { text: string; completed: boolean }) => `[${t.completed ? 'x' : ' '}] ${t.text}`).join('\n')}`;
    case 'context_compaction':
      return '[Context compaction]';
    default:
      return '';
  }
}
