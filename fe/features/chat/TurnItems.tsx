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
import { userInputReplyDisplayText } from '../../../util/user-input';
import { CompactionBoundaries, isCompactionBoundaryItem } from './CompactionMessage';

/** Place decisions at their tool call, so later execution and replies stay below them. */
export default function TurnItems({ turn, highlightedItemIds, subagents = [], ...resources }: {
  turn: Turn;
  highlightedItemIds?: string[];
  subagents?: SubagentConversation[];
  sessionId?: string;
  readOnly?: boolean;
  onUserInputAnswered?: (session: Session) => void;
  onNativeAnswer?: (request: import('../../../protocol/user-input-types').UserInputRequest, answer: string, answers: string[]) => Promise<void>;
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
  const additionalInputs = (turn.additionalUserInputs ?? []).map((text, index) => ({
    text, index,
    beforeItemIndex: Math.max(0, Math.min(turn.items.length,
      turn.additionalUserInputPositions?.[index]?.beforeItemIndex ?? turn.items.length)),
  }));
  const renderInputs = (beforeItemIndex: number) => additionalInputs.filter(input => input.beforeItemIndex === beforeItemIndex)
    .map(input => <div className="user-message additional-user-message" key={`${turn.id}-additional-${input.index}`}><small>追加消息</small><p>{userInputReplyDisplayText(input.text)}</p></div>);
  const boundaries = new Set(turn.compactions?.map(boundary => boundary.beforeItemIndex));
  for (const input of additionalInputs) boundaries.add(input.beforeItemIndex);
  if (subagentIndex >= 0) boundaries.add(subagentIndex);
  return <>
    {groupThreadItems(turn.items, boundaries, mobile).map(group => {
      const index = group.startIndex;
      const first = group.type === 'item' ? group.item : group.items[0];
      return <Fragment key={first.id}>{renderInputs(index)}{index === subagentIndex && <SubagentConversations agents={subagents} {...resources} />}<CompactionBoundaries turn={turn} index={index} {...resources} />{group.type === 'reasoning'
        ? <ReasoningSummary pending={turn.status === 'running' && index + group.items.length === turn.items.length} entries={group.items.map(item => ({ item, timestamp: turn.itemTimestamps?.[item.id] || turn.startedAt, anchorId: `turn-${turn.id}-item-${item.id}`, highlighted: highlightedItemIds?.includes(item.id) }))} {...resources} />
        : group.type === 'tools' ? <ToolCallGroup turnStatus={turn.status} entries={group.items.map(item => ({ item, timestamp: turn.itemTimestamps?.[item.id] || turn.startedAt, anchorId: `turn-${turn.id}-item-${item.id}`, highlighted: highlightedItemIds?.includes(item.id) }))} {...resources} />
        : isCompactionBoundaryItem(turn, index) ? null : <div id={`turn-${turn.id}-item-${group.item.id}`} className={highlightedItemIds?.includes(group.item.id) ? 'billing-item-selected' : undefined}>{resources.sessionId && turn.userInputRequests?.some(request => request.id === group.item.id)
          ? <UserInputCard request={turn.userInputRequests.find(request => request.id === group.item.id)!} sessionId={resources.sessionId} turnId={turn.id} readOnly={resources.readOnly} onAnswered={resources.onUserInputAnswered ?? (() => {})} onNativeAnswer={resources.onNativeAnswer} />
          : <ItemView item={group.item} turnStatus={turn.status} timestamp={turn.itemTimestamps?.[group.item.id] || turn.startedAt} {...resources} />}</div>}</Fragment>;
    })}
    {renderInputs(turn.items.length)}
    <CompactionBoundaries turn={turn} index={turn.items.length} {...resources} />
    {subagentIndex < 0 && <SubagentConversations agents={subagents} {...resources} />}
    {resources.sessionId && turn.userInputRequests?.filter(request => !turn.items.some(item => item.id === request.id)).map(request => <UserInputCard key={request.id} request={request} sessionId={resources.sessionId!} turnId={turn.id} readOnly={resources.readOnly} onAnswered={resources.onUserInputAnswered ?? (() => {})} onNativeAnswer={resources.onNativeAnswer} />)}
  </>;
}
