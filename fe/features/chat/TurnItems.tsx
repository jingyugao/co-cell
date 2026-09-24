import { Fragment } from 'react';
import type { UserApproval } from '../../../protocol/approval-types';
import type { SubagentConversation, Turn } from '../../../protocol/types';
import type { MarkdownResources } from './Markdown';
import ItemView from './ItemView';
import ToolDetails from './ToolDetails';
import UserApprovalCard from './UserApprovalCard';
import UserInputCard from './UserInputCard';
import { matchApprovalItems } from './approval-items';
import SubagentConversations from './SubagentConversations';

/** Place decisions at their tool call, so later execution and replies stay below them. */
export default function TurnItems({ turn, sessionId, onApprovalResolved, onUserInputAnswered, highlightedItemIds, subagents = [], ...resources }: {
  turn: Turn;
  highlightedItemIds?: string[];
  subagents?: SubagentConversation[];
  sessionId: string;
  onApprovalResolved: (approval: UserApproval) => void;
  onUserInputAnswered: (session: import('../../../protocol/types').Session) => void;
} & MarkdownResources) {
  const { matches, unmatched } = matchApprovalItems(turn.items, turn.approvals ?? []);
  const firstSubagentAt = subagents[0]?.startedAt;
  const timedSubagentIndex = firstSubagentAt && turn.itemTimestamps
    ? turn.items.findIndex(item => (turn.itemTimestamps?.[item.id] ?? turn.startedAt) >= firstSubagentAt)
    : -1;
  // App Server history omits item timestamps. Place the child work before the
  // parent's final reply in that case.
  const subagentIndex = firstSubagentAt && timedSubagentIndex < 0
    ? turn.items.reduce((last, item, index) => item.type === 'agent_message' ? index : last, -1) : timedSubagentIndex;
  const renderApproval = (approval: UserApproval) => <UserApprovalCard key={approval.id}
    approval={approval} sessionId={sessionId} turnId={turn.id} turnStatus={turn.status}
    onResolved={onApprovalResolved} {...resources} />;
  return <>
    {turn.items.map((item, index) => {
      const approval = matches.get(item.id);
      return <Fragment key={item.id}>{index === subagentIndex && <SubagentConversations agents={subagents} {...resources} />}{turn.compactions?.filter(boundary => boundary.beforeItemIndex === index).map(boundary => <div key={boundary.segment} className="compact-divider" role="separator">上下文已压缩 · 第 {boundary.segment + 1} 段对话 · 后续重新计费</div>)}<div id={`turn-${turn.id}-item-${item.id}`} className={highlightedItemIds?.includes(item.id) ? 'billing-item-selected' : undefined}>{approval ? <Fragment key={item.id}>{renderApproval(approval)}<ToolDetails item={item} /></Fragment>
        : <ItemView key={item.id} item={item} turnStatus={turn.status} timestamp={turn.itemTimestamps?.[item.id] || turn.startedAt} {...resources} />}</div></Fragment>;
    })}
    {turn.compactions?.filter(boundary => boundary.beforeItemIndex >= turn.items.length).map(boundary => <div key={boundary.segment} className="compact-divider" role="separator">上下文已压缩 · 第 {boundary.segment + 1} 段对话 · 后续重新计费</div>)}
    {/* A request can arrive before its SDK item. Keep it actionable without inventing a match. */}
    {unmatched.map(renderApproval)}
    {turn.userInputRequests?.map(request => <UserInputCard key={request.id} request={request} sessionId={sessionId} turnId={turn.id} onAnswered={onUserInputAnswered} />)}
    {subagentIndex < 0 && <SubagentConversations agents={subagents} {...resources} />}
  </>;
}
