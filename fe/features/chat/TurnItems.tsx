import { Fragment } from 'react';
import type { SubagentConversation, Turn } from '../../../protocol/types';
import type { MarkdownResources } from './Markdown';
import ItemView from './ItemView';
import SubagentConversations from './SubagentConversations';
import ReasoningSummary, { groupThreadItems } from './ReasoningSummary';
import UserInputCard from './UserInputCard';
import type { Session } from '../../../protocol/types';
import ToolCallGroup from './ToolCallGroup';
import { useMobileLayout } from './useMobileViewport';

/** Place decisions at their tool call, so later execution and replies stay below them. */
export default function TurnItems({ turn, highlightedItemIds, subagents = [], ...resources }: {
  turn: Turn;
  highlightedItemIds?: string[];
  subagents?: SubagentConversation[];
  sessionId?: string;
  onUserInputAnswered?: (session: Session) => void;
} & MarkdownResources) {
  const mobile = useMobileLayout();
  const firstSubagentAt = subagents[0]?.startedAt;
  const timedSubagentIndex = firstSubagentAt && turn.itemTimestamps
    ? turn.items.findIndex(item => (turn.itemTimestamps?.[item.id] ?? turn.startedAt) >= firstSubagentAt)
    : -1;
  // App Server history omits item timestamps. Place the child work before the
  // parent's final reply in that case.
  const subagentIndex = firstSubagentAt && timedSubagentIndex < 0
    ? turn.items.reduce((last, item, index) => item.type === 'agent_message' ? index : last, -1) : timedSubagentIndex;
  const boundaries = new Set(turn.compactions?.map(boundary => boundary.beforeItemIndex));
  if (subagentIndex >= 0) boundaries.add(subagentIndex);
  return <>
    {groupThreadItems(turn.items, boundaries, mobile).map(group => {
      const index = group.startIndex;
      const first = group.type === 'item' ? group.item : group.items[0];
      return <Fragment key={first.id}>{index === subagentIndex && <SubagentConversations agents={subagents} {...resources} />}{turn.compactions?.filter(boundary => boundary.beforeItemIndex === index).map(boundary => <div key={boundary.segment} className="compact-divider" role="separator">上下文已压缩 · 第 {boundary.segment + 1} 段对话 · 后续重新计费</div>)}{group.type === 'reasoning'
        ? <ReasoningSummary pending={turn.status === 'running' && index + group.items.length === turn.items.length} entries={group.items.map(item => ({ item, timestamp: turn.itemTimestamps?.[item.id] || turn.startedAt, anchorId: `turn-${turn.id}-item-${item.id}`, highlighted: highlightedItemIds?.includes(item.id) }))} {...resources} />
        : group.type === 'tools' ? <ToolCallGroup turnStatus={turn.status} entries={group.items.map(item => ({ item, timestamp: turn.itemTimestamps?.[item.id] || turn.startedAt, anchorId: `turn-${turn.id}-item-${item.id}`, highlighted: highlightedItemIds?.includes(item.id) }))} {...resources} />
        : <div id={`turn-${turn.id}-item-${group.item.id}`} className={highlightedItemIds?.includes(group.item.id) ? 'billing-item-selected' : undefined}>{resources.sessionId && turn.userInputRequests?.some(request => request.id === group.item.id)
          ? <UserInputCard request={turn.userInputRequests.find(request => request.id === group.item.id)!} sessionId={resources.sessionId} turnId={turn.id} onAnswered={resources.onUserInputAnswered ?? (() => {})} />
          : <ItemView item={group.item} turnStatus={turn.status} timestamp={turn.itemTimestamps?.[group.item.id] || turn.startedAt} {...resources} />}</div>}</Fragment>;
    })}
    {turn.compactions?.filter(boundary => boundary.beforeItemIndex >= turn.items.length).map(boundary => <div key={boundary.segment} className="compact-divider" role="separator">上下文已压缩 · 第 {boundary.segment + 1} 段对话 · 后续重新计费</div>)}
    {subagentIndex < 0 && <SubagentConversations agents={subagents} {...resources} />}
    {resources.sessionId && turn.userInputRequests?.filter(request => !turn.items.some(item => item.id === request.id)).map(request => <UserInputCard key={request.id} request={request} sessionId={resources.sessionId!} turnId={turn.id} onAnswered={resources.onUserInputAnswered ?? (() => {})} />)}
  </>;
}
