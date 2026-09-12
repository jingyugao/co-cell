import type { ThreadItem } from '../../../protocol/agent-protocol';
import type { UserApproval } from '../../../protocol/approval-types';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const isApprovalCall = (item: ThreadItem) => item.type === 'mcp_tool_call'
  && item.server === 'swarm_approvals' && item.tool === 'request_user_approval';

function receiptId(item: ThreadItem): string | undefined {
  if (item.type !== 'mcp_tool_call') return;
  const result = object(item.result);
  const structured = object(result?.structured_content ?? result?.structuredContent);
  if (typeof structured?.id === 'string') return structured.id;
  if (!Array.isArray(result?.content)) return;
  for (const block of result.content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const receipt = object(JSON.parse(block.text));
      if (typeof receipt?.id === 'string') return receipt.id;
    } catch { /* Non-JSON MCP text is not an approval receipt. */ }
  }
}

function sameInput(item: ThreadItem, approval: UserApproval): boolean {
  if (item.type !== 'mcp_tool_call') return false;
  const input = object(item.arguments);
  return Boolean(input && ['title', 'target', 'impact'].every(key =>
    typeof input[key] === 'string' && (input[key] as string).trim() === approval[key as 'title' | 'target' | 'impact'])
    && input.action === approval.action);
}

/** Completed tools carry the exact request ID. Match waiting tools only when unambiguous. */
export function matchApprovalItems(items: ThreadItem[], approvals: UserApproval[]) {
  const matches = new Map<string, UserApproval>();
  const used = new Set<string>();
  const calls = items.filter(isApprovalCall);
  for (const item of calls) {
    const id = receiptId(item);
    const approval = approvals.find(value => value.id === id);
    if (approval && !used.has(approval.id)) { matches.set(item.id, approval); used.add(approval.id); }
  }
  for (const item of calls) {
    if (matches.has(item.id) || receiptId(item)) continue;
    const candidates = approvals.filter(approval => !used.has(approval.id) && sameInput(item, approval));
    if (candidates.length !== 1) continue;
    const approval = candidates[0];
    const possibleCalls = calls.filter(call => !matches.has(call.id) && !receiptId(call) && sameInput(call, approval));
    if (possibleCalls.length !== 1) continue;
    matches.set(item.id, approval); used.add(approval.id);
  }
  return { matches, unmatched: approvals.filter(approval => !used.has(approval.id)) };
}
