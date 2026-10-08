import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from '../support/fixtures.mjs';
import { createConversation, fileURL, runAgent } from '../support/agent.mjs';

test('core: sessions share workspace only within their project and deletion preserves the other project', async ({ environment: env }) => {
  const first = await env.createProject('isolation-a'), second = await env.createProject('isolation-b');
  const a = await env.waitProject(first.id, { kind: 'create', status: 'ready' });
  const b = await env.waitProject(second.id, { kind: 'create', status: 'ready' });
  assert.notEqual(a.sandbox.id, b.sandbox.id);
  const owner = await createConversation(env, first, 'Workspace owner');
  const peer = await createConversation(env, first, 'Same project peer');
  const other = await createConversation(env, second, 'Other project');
  const filename = `isolation-${randomUUID()}.txt`, markerA = randomUUID(), markerB = randomUUID(), privateMarker = randomUUID();
  await env.step('First session writes a file and remembers a conversation-only marker', async () => {
    const result = await runAgent(env, owner, `Use Node standard libraries to write ${filename} containing exactly ${markerA}. Remember ${privateMarker} in this conversation only; do not write it in any file. Reply ${privateMarker}. Do not use subagents or external systems.`);
    assert(result.text.includes(privateMarker));
    assert.equal((await env.json(fileURL(a, filename))).trim(), markerA);
    return { threadId: result.session.threadId };
  });
  await env.step('A sibling session reads the shared file but has a separate transcript', async () => {
    const result = await runAgent(env, peer, `Read ${filename} using Node and reply with its exact content. Do not use subagents or external systems.`);
    assert(result.text.includes(markerA));
    assert(!JSON.stringify(result.session.turns).includes(privateMarker), 'Sibling transcript contains private conversation');
    const original = await env.json(`/api/sessions/${owner.id}`);
    assert.notEqual(original.threadId, result.session.threadId);
    return { ownerThread: original.threadId, peerThread: result.session.threadId };
  });
  await env.step('Another project has no first-project file or history and owns its own content', async () => {
    const result = await runAgent(env, other, `Use Node to assert ${filename} does not exist, then write it containing exactly ${markerB}. Do not use subagents or external systems. Reply ${markerB}.`);
    assert(!JSON.stringify(result.session.turns).includes(privateMarker));
    assert.equal((await env.json(fileURL(b, filename))).trim(), markerB);
    assert.equal((await env.json(fileURL(a, filename))).trim(), markerA);
    return { firstSandbox: a.sandbox.id, secondSandbox: b.sandbox.id };
  });
  await env.step('Deleting one session keeps shared files and deleting its project removes its resources', async () => {
    await env.json(`/api/sessions/${owner.id}`, { method: 'DELETE' });
    await env.request(`/api/sessions/${owner.id}`, { expectedStatus: 404 });
    assert.equal((await env.json(fileURL(a, filename))).trim(), markerA);
    assert((await env.json(`/api/sessions/${peer.id}`)).threadId);
    await env.json(`/api/projects/${first.id}`, { method: 'DELETE', timeoutMs: env.config.operationTimeout });
    await env.request(`/api/projects/${first.id}`, { expectedStatus: 404 });
    await env.request(`/api/sessions/${peer.id}`, { expectedStatus: 404 });
    const inventory = await env.json('/api/sandboxes');
    assert(!inventory.sandboxes.some(box => box.id === a.sandbox.id));
    assert(inventory.sandboxes.some(box => box.id === b.sandbox.id));
    assert.equal((await env.json(fileURL(b, filename))).trim(), markerB);
    assert((await env.json(`/api/sessions/${other.id}`)).threadId);
    return { deletedSandbox: a.sandbox.id, survivingSandbox: b.sandbox.id };
  });
});
