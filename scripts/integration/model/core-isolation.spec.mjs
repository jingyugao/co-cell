import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from '../support/fixtures.mjs';
import { connectEvents, createConversation, fileURL, runAgent } from '../support/agent.mjs';

test('core: sessions share workspace only within their project and deletion preserves the other project', async ({ environment: env }) => {
  const first = await env.createProject('isolation-a'), second = await env.createProject('isolation-b');
  const a = await env.waitProject(first.id, { kind: 'create', status: 'ready' });
  const b = await env.waitProject(second.id, { kind: 'create', status: 'ready' });
  assert.notEqual(a.sandbox.id, b.sandbox.id);
  const owner = await createConversation(env, first, 'Workspace owner');
  const peer = await createConversation(env, first, 'Same project peer');
  const other = await createConversation(env, second, 'Other project');
  const filename = `isolation-${randomUUID()}.txt`, markerA = randomUUID(), markerB = randomUUID(), privateMarker = randomUUID();
  const events = await connectEvents(env, other); env.transports.push(events);
  await events.wait(message => message.type === 'snapshot' && message.session.id === other.id);
  const servicePrompt = marker => `Also create a Node HTTP service using only standard libraries. Bind 127.0.0.1:18081. GET /healthz must return JSON with marker=${marker}, pid=process.pid and instance=crypto.randomUUID() generated once at startup. Start with a detached child, stdin ignored, stdout/stderr in a project-local log and child.unref(). Make an actual HTTP request, then leave the service running.`;
  const health = project => env.json(`/api/projects/${project.id}/service/18081/healthz`);
  await env.step('First session writes a file and remembers a conversation-only marker', async () => {
    const result = await runAgent(env, owner, `Use Node standard libraries to write ${filename} containing exactly ${markerA}. Remember ${privateMarker} in this conversation only; do not write it in any file. ${servicePrompt(markerA)} Reply ${privateMarker}. Do not use subagents or external systems.`);
    assert(result.text.includes(privateMarker));
    assert.equal((await env.json(fileURL(a, filename))).trim(), markerA);
    assert.equal((await health(first)).marker, markerA);
    return { threadId: result.session.threadId };
  });
  await env.step('A sibling session reads the shared file but has a separate transcript', async () => {
    const result = await runAgent(env, peer, `Read ${filename} using Node and reply with its exact content. Do not use subagents or external systems.`);
    assert(result.text.includes(markerA));
    assert(!JSON.stringify(result.session.turns).includes(privateMarker), 'Sibling transcript contains private conversation');
    const original = await env.json(`/api/sessions/${owner.id}`);
    assert.notEqual(original.threadId, result.session.threadId);
    assert(events.messages.every(message => message.type !== 'sdk'), 'Another project received first-project execution events');
    assert(events.messages.every(message => !message.session || message.session.id === other.id), 'SSE snapshot contains another session');
    return { ownerThread: original.threadId, peerThread: result.session.threadId };
  });
  await env.step('Another project has no first-project file or history and owns its own content', async () => {
    const result = await runAgent(env, other, `Use Node to assert ${filename} does not exist, then write it containing exactly ${markerB}. ${servicePrompt(markerB)} Do not use subagents or external systems. Reply ${markerB}.`);
    assert(!JSON.stringify(result.session.turns).includes(privateMarker));
    assert.equal((await env.json(fileURL(b, filename))).trim(), markerB);
    assert.equal((await env.json(fileURL(a, filename))).trim(), markerA);
    const [httpA, httpB] = await Promise.all([health(first), health(second)]);
    assert.equal(httpA.marker, markerA); assert.equal(httpB.marker, markerB);
    assert.notEqual(httpA.instance, httpB.instance, 'Projects share a service process');
    assert(!JSON.stringify(events.messages).includes(privateMarker), 'Private first-session content leaked into another project stream');
    return { firstSandbox: a.sandbox.id, secondSandbox: b.sandbox.id };
  });
  await env.step('Deleting one session keeps shared files and deleting its project removes its resources', async () => {
    await env.json(`/api/sessions/${owner.id}`, { method: 'DELETE' });
    await env.request(`/api/sessions/${owner.id}`, { expectedStatus: 404 });
    assert.equal((await env.json(fileURL(a, filename))).trim(), markerA);
    assert.equal((await health(first)).marker, markerA, 'Deleting a session stopped the project service');
    assert((await env.json(`/api/sessions/${peer.id}`)).threadId);
    await env.json(`/api/projects/${first.id}`, { method: 'DELETE', timeoutMs: env.config.operationTimeout });
    await env.request(`/api/projects/${first.id}`, { expectedStatus: 404 });
    await env.request(`/api/sessions/${peer.id}`, { expectedStatus: 404 });
    await env.request(`/api/projects/${first.id}/service/18081/healthz`, { expectedStatus: 404 });
    const inventory = await env.json('/api/sandboxes');
    assert(!inventory.sandboxes.some(box => box.id === a.sandbox.id));
    assert(inventory.sandboxes.some(box => box.id === b.sandbox.id));
    assert.equal((await env.json(fileURL(b, filename))).trim(), markerB);
    assert.equal((await health(second)).marker, markerB, 'Deleting another project stopped this service');
    assert((await env.json(`/api/sessions/${other.id}`)).threadId);
    return { deletedSandbox: a.sandbox.id, survivingSandbox: b.sandbox.id };
  });
});
