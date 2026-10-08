import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from '../support/fixtures.mjs';
import { connectEvents, createConversation, fileURL, finish, runAgent, submit, waitCommandStart } from '../support/agent.mjs';

test('core: SSE reconnect preserves an active turn, stop converges and the next turn executes', async ({ environment: env }) => {
  const project = await env.createProject('stop-events');
  const ready = await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  const session = await createConversation(env, project, 'Stop and SSE reconnect');
  const marker = randomUUID(), filename = `stop-${marker}.txt`;
  let events = await connectEvents(env, session);
  try {
    await events.wait(message => message.type === 'snapshot' && message.session.id === session.id);
    const { turnId } = await env.step('Start an actual long-running foreground command', () => submit(env, session,
      `This is a platform integration test. Do not use subagents, credentials or external systems. Run one foreground Node command that writes ${filename} containing ${marker}, prints ${marker}, then waits 120 seconds before exiting. Use exec_command yield_time_ms=1000 and poll that same command until completion. Wait before ending your turn; do not detach it or start unrelated work.`));
    await waitCommandStart(env, session, marker);
    const running = await env.json(`/api/sessions/${session.id}`);
    assert.equal(running.turns.find(turn => turn.id === turnId || turn.nativeTurnId === turnId)?.status, 'running');
    const threadId = running.threadId; assert(threadId);
    await env.step('Disconnect and reconnect the actual SSE stream without resubmitting', async () => {
      await events.close(); events = await connectEvents(env, session);
      const snapshot = await events.wait(message => message.type === 'snapshot' && message.session.threadId === threadId);
      assert.equal(snapshot.session.turns.find(turn => turn.id === turnId || turn.nativeTurnId === turnId)?.status, 'running');
      return { threadId, turnId, snapshotType: snapshot.type };
    });
    await env.step('Stop the turn and observe cancellation through SSE and native history', async () => {
      await env.json(`/api/sessions/${session.id}/stop`, { method: 'POST', body: {}, timeoutMs: 60_000 });
      const stopped = await finish(env, session, turnId, 'cancelled');
      await events.wait(message => message.type === 'state' && message.session.status === 'cancelled');
      assert.equal(stopped.session.threadId, threadId);
      assert.equal(stopped.session.turns.filter(turn => turn.prompt.includes(filename)).length, 1, 'Reconnect resubmitted the task');
      return { status: stopped.turn.status, threadId };
    });
    await env.step('A follow-up can execute commands in the same native conversation', async () => {
      const next = await runAgent(env, session, `Use Node to write ${filename} with exactly recovered-${marker}. Do not use other tools or external systems. Then reply recovered-${marker}.`);
      assert.equal(next.session.threadId, threadId);
      assert(next.turn.items.some(item => item.type === 'command_execution'));
      assert.equal((await env.json(fileURL(ready, filename))).trim(), `recovered-${marker}`);
      return { threadId, turnId: next.turn.id };
    });
  } finally { await events.close(); }
});

test('core: an invalid model fails explicitly and valid settings allow the next turn', async ({ environment: env }) => {
  const project = await env.createProject('model-failure');
  await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  const session = await createConversation(env, project, 'Model failure recovery');
  await env.json(`/api/sessions/${session.id}`, { method: 'PATCH', body: { settings: { ...session.settings, model: `nonexistent-ci-model-${randomUUID()}` } } });
  await env.step('Unsupported model becomes a failed turn and releases the project', async () => {
    const { turnId } = await submit(env, session, 'Reply OK without tools.');
    const failed = await finish(env, session, turnId, 'failed');
    assert(failed.turn.error, 'Model failure has no actionable error');
    return { status: failed.turn.status, error: env.redact(failed.turn.error) };
  });
  await env.json(`/api/sessions/${session.id}`, { method: 'PATCH', body: { settings: session.settings } });
  await env.step('Correct the model and execute the next turn without recreating the project', async () => {
    const marker = randomUUID();
    const result = await runAgent(env, session, `Reply exactly ${marker}. Do not use tools.`);
    assert(result.text.includes(marker));
    assert(result.session.turns.some(turn => turn.status === 'failed'), 'Failed turn disappeared from history');
    return { threadId: result.session.threadId, model: result.session.settings.model };
  });
});
