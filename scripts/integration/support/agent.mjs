import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function createConversation(env, project, title) {
  return env.json('/api/sessions', { method: 'POST', expectedStatus: 201, body: {
    projectId: project.id, title,
    settings: { model: env.config.model, modelReasoningEffort: 'low', webSearchMode: 'disabled' },
  } });
}

export async function waitFor(env, description, read, check, timeout = env.config.turnTimeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (check(result)) return result;
    await delay(500, undefined, { signal: env.controller.signal });
  }
  throw new Error(`Timed out: ${description}`);
}

export async function submit(env, session, prompt) {
  return env.json(`/api/sessions/${session.id}/turns`, { method: 'POST', expectedStatus: 202, body: { prompt, images: [] } });
}

export async function finish(env, session, turnId, status = 'completed') {
  const current = await waitFor(env, `turn ${turnId}`, () => env.json(`/api/sessions/${session.id}`),
    current => current.turns.some(turn => (turn.id === turnId || turn.nativeTurnId === turnId) && turn.status !== 'running'));
  const turn = current.turns.find(turn => turn.id === turnId || turn.nativeTurnId === turnId);
  assert.equal(turn.status, status, env.redact(turn.error ?? 'Unexpected agent turn status'));
  if (status === 'completed') assert(current.threadId, 'Missing native thread');
  await env.waitIdle(session.projectId);
  return { session: current, turn, text: turn.items.filter(item => item.type === 'agent_message').map(item => item.text).join('\n') };
}

export async function runAgent(env, session, prompt) {
  const { turnId } = await submit(env, session, prompt);
  return finish(env, session, turnId);
}

export const fileURL = (project, path) => `/api/projects/${project.id}/files/content?path=${encodeURIComponent(`${project.workingDirectory}/${path}`)}`;

export async function waitCommandStart(env, session, marker) {
  return waitFor(env, 'actual command execution', () => env.json(`/api/sessions/${session.id}`), current => {
    const turn = current.turns.at(-1);
    assert.equal(turn?.status, 'running', env.redact(turn?.error ?? 'Turn ended before the expected command output'));
    return turn.items.some(item => item.type === 'command_execution' && item.status === 'in_progress' && item.command.includes(marker));
  });
}

/** A real SSE connection; reconnection must receive a fresh server snapshot. */
export async function connectEvents(env, session) {
  const abort = new AbortController();
  const response = await env.fetch(`/api/sessions/${session.id}/events`, { signal: abort.signal, timeoutMs: env.config.turnTimeout });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const messages = [];
  let failure, buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) messages.push(JSON.parse(data));
        }
      }
      if (!abort.signal.aborted) failure = new Error('SSE disconnected unexpectedly');
    } catch (error) { if (!abort.signal.aborted) failure = error; }
  })();
  return { messages, async wait(check) {
    return waitFor(env, 'SSE message', async () => { if (failure) throw failure; return messages.find(check); }, Boolean);
  }, async close() { abort.abort(); await reader.cancel().catch(() => {}); await pump; } };
}
