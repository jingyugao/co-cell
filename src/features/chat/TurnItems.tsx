import { Fragment } from 'react';
import type { UserApproval } from '../../../shared/approval-types';
import type { Turn } from '../../../shared/types';
import type { MarkdownResources } from './Markdown';
import ItemView from './ItemView';
import ToolDetails from './ToolDetails';
import UserApprovalCard from './UserApprovalCard';
import { matchApprovalItems } from './approval-items';

/** Place decisions at their tool call, so later execution and replies stay below them. */
export default function TurnItems({ turn, sessionId, onApprovalResolved, ...resources }: {
  turn: Turn;
  sessionId: string;
  onApprovalResolved: (approval: UserApproval) => void;
} & MarkdownResources) {
  const { matches, unmatched } = matchApprovalItems(turn.items, turn.approvals ?? []);
  const renderApproval = (approval: UserApproval) => <UserApprovalCard key={approval.id}
    approval={approval} sessionId={sessionId} turnId={turn.id} turnStatus={turn.status}
    onResolved={onApprovalResolved} {...resources} />;
  return <>
    {turn.items.map(item => {
      const approval = matches.get(item.id);
      return approval ? <Fragment key={item.id}>{renderApproval(approval)}<ToolDetails item={item} /></Fragment>
        : <ItemView key={item.id} item={item} turnStatus={turn.status} timestamp={turn.itemTimestamps?.[item.id] || turn.startedAt} {...resources} />;
    })}
    {/* A request can arrive before its SDK item. Keep it actionable without inventing a match. */}
    {unmatched.map(renderApproval)}
  </>;
}
