import { test, expect } from './fixture.mjs';

test('subagent read failures retry after readiness and clear the warning on success', async ({ page, ui }) => {
  ui.complete('paused');
  let reads = 0;
  await page.route('**/api/sessions/old-session/subagents', async route => {
    reads++;
    await route.fulfill(reads === 1 ? { status: 503, json: { error: 'Sandbox 正忙，请稍后重试' } } : { json: [] });
  });
  // Start observing the transient warning before the full-page load can outlast
  // the retry interval (for example, on a cold Vite dependency cache).
  await page.goto('/sessions/old-session', { waitUntil: 'domcontentloaded' });
  const warning = page.getByText('子代理对话暂时无法加载，正在自动重试。', { exact: true });
  await expect(warning).toBeVisible();
  await expect.poll(() => reads).toBe(2);
  await expect(warning).toHaveCount(0);
});

test('a session without a native thread does not request subagent history', async ({ page, ui }) => {
  ui.complete('paused');
  ui.sessions.get('old-session').threadId = null;
  await page.goto('/sessions/old-session');
  await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
  expect(ui.count('GET', '/api/sessions/old-session/subagents')).toBe(0);
});

test('first message stays in one frame when native acceptance precedes its stream event', async ({ page, ui }) => {
  ui.complete('paused');
  const session = ui.sessions.get('old-session');
  const pending = { id: 'web-turn', prompt: 'hello', images: [], items: [], status: 'running',
    codexAccepted: false, startedAt: session.createdAt };
  const accepted = { ...pending, nativeTurnId: 'native-turn', codexAccepted: true };
  const answer = { id: 'answer', type: 'agent_message', text: 'Hello! How can I help?' };
  const completed = { ...accepted, status: 'completed', completedAt: session.createdAt };
  session.status = 'completed';
  session.turns = [{ ...completed, items: [answer] }];
  let opened = false;
  await page.route('**/api/sessions/old-session/events', async route => {
    const messages = opened ? [{ type: 'snapshot', session }] : [
      { type: 'snapshot', session: { ...session, status: 'running', turns: [pending] } },
      { type: 'state', session: { ...session, status: 'running', turns: [accepted] } },
      { type: 'sdk', turnId: pending.id, event: { type: 'turn.started', turn_id: accepted.nativeTurnId } },
      { type: 'sdk', turnId: pending.id, event: { type: 'item.completed', item: answer } },
      { type: 'sdk', turnId: pending.id, event: { type: 'turn.completed' } },
      { type: 'state', session: { ...session, turns: [completed] } },
    ];
    opened = true;
    await route.fulfill({ contentType: 'text/event-stream', body: messages.map(message => `data: ${JSON.stringify(message)}\n\n`).join('') });
  });
  await page.goto('/sessions/old-session');
  await expect(page.getByText(answer.text, { exact: true })).toBeVisible();
  await expect(page.locator('.turn-list > .turn')).toHaveCount(1);
  await expect(page.locator('.user-message > p')).toHaveText('hello');
  await expect(page.locator('.assistant-header')).toContainText('已完成');
  await page.reload();
  await expect(page.getByText(answer.text, { exact: true })).toBeVisible();
  await expect(page.locator('.turn-list > .turn')).toHaveCount(1);
});
