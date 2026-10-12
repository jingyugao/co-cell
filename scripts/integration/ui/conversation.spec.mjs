import { test, expect } from './fixture.mjs';

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
