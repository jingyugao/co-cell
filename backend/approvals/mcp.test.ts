import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import type { UserApproval } from '../../protocol/approval-types.js';
import { ApprovalMcpService, installApprovalMcpRoutes, type ApprovalMcpContext } from './mcp.js';

const context: ApprovalMcpContext = { sessionId: randomUUID(), turnId: randomUUID(), projectId: randomUUID() };
const input = { title: '确认操作', target: 'uat / database', action: 'ALTER TABLE example ADD COLUMN note TEXT;', impact: '变更一张表的结构' };
const secret = 'test-secret-that-is-deliberately-longer-than-thirty-two-bytes';

test('uses a fixed bearer token', () => {
  const service = new ApprovalMcpService(secret, async () => { throw new Error('unused'); });
  assert.equal(service.authenticate(secret), true);
  assert.equal(service.authenticate(`${secret.slice(0, -1)}x`), false);
});

test('tool call remains pending until the user decision is returned', async () => {
  let release!: (approval: UserApproval) => void;
  let called!: () => void;
  const started = new Promise<void>(resolve => { called = resolve; });
  const service = new ApprovalMcpService(secret, async (_context, received, id) => {
    assert.deepEqual(received, input);
    called();
    return new Promise<UserApproval>(resolve => { release = resolve; });
  });
  const operation = service.handle(context, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
    name: 'request_user_approval', arguments: input,
  } }, new AbortController().signal);
  await started;
  let settled = false;
  void operation.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  const approval: UserApproval = { ...input, id: randomUUID(), status: 'approved', createdAt: new Date().toISOString(), resolvedAt: new Date().toISOString() };
  release(approval);
  const response = await operation;
  assert.equal(response.status, 200);
  const result = (response.body as { result: { structuredContent: UserApproval & { approved: boolean } } }).result.structuredContent;
  assert.equal(result.id, approval.id);
  assert.equal(result.status, 'approved');
  assert.equal(result.approved, true);
});

test('async question returns only after the question is saved, without waiting for its answer', async () => {
  const questions = [{ title: 'Which environment?', options: ['UAT', 'Production'] }];
  let save!: () => void;
  const saved = new Promise<void>(resolve => { save = resolve; });
  const service = new ApprovalMcpService(secret, async () => { throw new Error('unused'); }, async (receivedContext, received, id) => {
    assert.deepEqual(receivedContext, context);
    assert.deepEqual(received, questions);
    assert.equal(id, 'call-123');
    await saved;
    return { id, questions, status: 'pending', createdAt: new Date().toISOString() };
  });
  const operation = service.handle(context, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: {
    name: 'request_user_input_async', arguments: { questions }, _meta: { callId: 'call-123' },
  } }, new AbortController().signal);
  let settled = false;
  void operation.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  save();
  const response = await operation;
  assert.deepEqual((response.body as { result: { structuredContent: unknown } }).result.structuredContent,
    { accepted: true, requestId: 'call-123' });
});

test('async question rejects malformed payloads', async () => {
  const service = new ApprovalMcpService(secret, async () => { throw new Error('unused'); }, async () => { throw new Error('should not be called'); });
  const response = await service.handle(context, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: {
    name: 'request_user_input_async', arguments: { questions: [{ title: '' }] },
  } }, new AbortController().signal);
  assert.equal((response.body as { result: { isError: boolean } }).result.isError, true);
});

test('initialize negotiates a supported protocol and notifications return no body', async () => {
  const service = new ApprovalMcpService(secret, async () => { throw new Error('unused'); });
  const initialized = await service.handle(context, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, new AbortController().signal);
  assert.equal((initialized.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-03-26');
  assert.deepEqual(await service.handle(context, { jsonrpc: '2.0', method: 'notifications/initialized' }, new AbortController().signal), { status: 202 });
});

test('HTTP transport rejects anonymous callers and accepts the fixed bearer token', async () => {
  const service = new ApprovalMcpService(secret, async () => { throw new Error('unused'); });
  const app = new Hono();
  installApprovalMcpRoutes(app, service);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await app.request('/mcp/approvals', { method: 'POST', body: JSON.stringify(request), headers: { 'content-type': 'application/json' } })).status, 401);
  const response = await app.request('/mcp/approvals', { method: 'POST', body: JSON.stringify(request), headers: {
    'content-type': 'application/json', authorization: `Bearer ${secret}`,
  } });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { result: { tools: Array<{ name: string }> } }).result.tools[0].name, 'request_user_approval');
  const tools = (await (await app.request('/mcp/approvals', { method: 'POST', body: JSON.stringify(request), headers: {
    'content-type': 'application/json', authorization: `Bearer ${secret}`,
  } })).json() as { result: { tools: Array<{ name: string }> } }).result.tools;
  assert.ok(tools.some(tool => tool.name === 'request_user_input_async'));
});
