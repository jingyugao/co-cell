import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadItem } from '../../../shared/agent-protocol';
import type { UserApproval } from '../../../shared/approval-types';
import { matchApprovalItems } from './approval-items';

const input = { title: '更新配置', target: '测试环境', action: '执行已保存的脚本', impact: '重启一个服务' };
const approval = (id: string, status: UserApproval['status'] = 'approved'): UserApproval => ({ ...input, id, status, createdAt: '2026-09-08T09:00:00Z' });
const call = (id: string, requestId?: string): ThreadItem => ({ id, type: 'mcp_tool_call', server: 'swarm_approvals', tool: 'request_user_approval', arguments: input,
  status: requestId ? 'completed' : 'in_progress', ...(requestId ? { result: { structured_content: null, content: [{ type: 'text' as const, text: JSON.stringify({ id: requestId, approved: true }) }] } } : {}) });

test('repeated approval requests follow their receipt IDs, not approval array order or identical text', () => {
  const first = approval('first'), retry = approval('retry');
  const result = matchApprovalItems([call('tool-1', 'first'), call('tool-2', 'retry')], [retry, first]);
  assert.equal(result.matches.get('tool-1')?.id, 'first');
  assert.equal(result.matches.get('tool-2')?.id, 'retry');
  assert.deepEqual(result.unmatched, []);
});

test('a waiting tool can match unique input, but concurrent identical requests remain unassigned', () => {
  const pending = approval('pending', 'pending');
  assert.equal(matchApprovalItems([call('tool')], [pending]).matches.get('tool')?.id, 'pending');
  const ambiguous = matchApprovalItems([call('tool-1'), call('tool-2')], [pending, approval('pending-2', 'pending')]);
  assert.equal(ambiguous.matches.size, 0);
  assert.equal(ambiguous.unmatched.length, 2);
});

test('unknown receipts, changed actions and unrelated MCP tools cannot take a decision card', () => {
  const pending = approval('pending', 'pending');
  assert.equal(matchApprovalItems([call('tool', 'unknown')], [pending]).matches.size, 0);
  assert.equal(matchApprovalItems([call('tool')], [{ ...pending, action: '另一段脚本' }]).matches.size, 0);
  const other = { ...call('tool', 'pending'), server: 'other' } as ThreadItem;
  assert.equal(matchApprovalItems([other], [pending]).matches.size, 0);
});
