import { memo } from 'react';
import type { Session, SubagentConversation } from '../../../protocol/types';
import type { UserInputRequest } from '../../../protocol/user-input-types';
import { userInputReplyDisplayText } from '../../../util/user-input';
import { Mark, Icon } from '../../components/Icon';
import type { FileSelection } from './Markdown';
import TurnContextStatus from './TurnContextStatus';
import TurnItems from './TurnItems';
import TurnProgress from './TurnProgress';

const statusLabels: Record<Session['status'], string> = { unknown: '尚未读取', idle: '就绪', running: '执行中', completed: '已完成', failed: '执行失败', cancelled: '已停止' };
const dateTime = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
const basename = (path: string) => path.replace(/[\\/]$/, '').split(/[\\/]/).pop() || '工作目录';

type BillingSelection = { blockId: string; turnId: string; itemIds?: string[] } | null;

/** Keep prompt-only state updates out of the expensive Markdown and tool-call tree. */
export function ConversationHistory({ session, billingSelection, projectReadOnly, subagents, onUserInputAnswered, onNativeAnswer, onOpenFile }: {
  session: Session;
  billingSelection: BillingSelection;
  projectReadOnly: boolean;
  subagents: SubagentConversation[];
  onUserInputAnswered: (session: Session) => void;
  onNativeAnswer?: (request: UserInputRequest, answer: string, answers: string[]) => Promise<void>;
  onOpenFile: (file: FileSelection) => void;
}) {
  return <div className="turn-list">{session.turns.map(turn => <article key={turn.id} id={`turn-${turn.id}`} className="turn">
    <div id={`turn-${turn.id}-item-user-input`} className={`user-message${billingSelection?.turnId === turn.id && billingSelection.itemIds?.includes('user-input') ? ' billing-item-selected' : ''}`}>
      <p>{userInputReplyDisplayText(turn.prompt)}</p><TurnContextStatus turn={turn} agentKind={session.agentKind} />
      <time className="message-time user-time" dateTime={turn.startedAt}>{dateTime(turn.startedAt)}</time>
      {turn.images.length > 0 && <div className="sent-images">{turn.images.map((path, index) => <span key={index}><Icon name="attach" size={13} />{basename(path)}</span>)}</div>}
    </div>
    <div className="assistant-header"><Mark small /><strong>CoCell</strong><span>{turn.clientFailure ? '发送未确认' : turn.status === 'running' ? '正在处理你的任务' : statusLabels[turn.status]}</span>{turn.completedAt && <time className="message-time" dateTime={turn.completedAt}>{dateTime(turn.completedAt)}</time>}</div>
    <div className="turn-items">
      <TurnItems sessionId={session.id} readOnly={projectReadOnly} onUserInputAnswered={onUserInputAnswered} onNativeAnswer={onNativeAnswer}
        highlightedItemIds={billingSelection?.turnId === turn.id ? billingSelection.itemIds : undefined}
        subagents={subagents.filter(agent => agent.startedAt >= turn.startedAt && agent.startedAt <= (turn.completedAt ?? new Date().toISOString()))}
        turn={turn} projectId={session.settings.executionMode === 'sandbox' ? session.projectId : undefined}
        workingDirectory={session.settings.workingDirectory} onOpenFile={onOpenFile} />
      {turn.error && <div className="inline-error">{turn.error}</div>}<TurnProgress turn={turn} />
      {turn.status === 'cancelled' && <div className="muted turn-note">任务已停止，可以继续发送消息。</div>}
    </div>
    {turn.usage && <div className="usage">输入 {turn.usage.input_tokens.toLocaleString()} · 输出 {turn.usage.output_tokens.toLocaleString()} tokens · 缓存 {turn.usage.cached_input_tokens.toLocaleString()}</div>}
  </article>)}</div>;
}

export default memo(ConversationHistory);
