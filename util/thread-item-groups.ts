import type { ThreadItem } from '../protocol/agent-protocol.js';

export type ToolItem = Extract<ThreadItem, { type: 'command_execution' | 'file_change' | 'mcp_tool_call' | 'web_search' }>;
export type ThreadItemGroup = { type: 'reasoning'; startIndex: number; items: Extract<ThreadItem, { type: 'reasoning' }>[] }
  | { type: 'tools'; startIndex: number; items: ToolItem[] }
  | { type: 'item'; startIndex: number; item: ThreadItem };

function isTool(item: ThreadItem): item is ToolItem {
  return ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type);
}

/** Preserve message order and explicit compaction/child-work boundaries. */
export function groupThreadItems(items: ThreadItem[], boundaries: ReadonlySet<number> = new Set(), groupTools = false): ThreadItemGroup[] {
  const groups: ThreadItemGroup[] = [];
  items.forEach((item, index) => {
    const previous = groups.at(-1);
    if (item.type === 'reasoning') {
      if (previous?.type === 'reasoning' && !boundaries.has(index)) previous.items.push(item);
      else groups.push({ type: 'reasoning', startIndex: index, items: [item] });
    } else if (groupTools && isTool(item) && !boundaries.has(index) && previous?.type === 'tools') {
      previous.items.push(item);
    } else if (groupTools && isTool(item) && !boundaries.has(index) && previous?.type === 'item' && isTool(previous.item)) {
      groups[groups.length - 1] = { type: 'tools', startIndex: previous.startIndex, items: [previous.item, item] };
    } else groups.push({ type: 'item', startIndex: index, item });
  });
  return groups;
}
