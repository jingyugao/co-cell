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
  await env.step('First session writes a file and persists its private user message', async () => {
    const prompt = `Use Node standard libraries to write ${filename} containing exactly ${markerA}. This conversation's private reference is ${privateMarker}; keep it in the conversation only and do not write it in any file. ${servicePrompt(markerA)} Do not use subagents or external systems.`;
    const result = await runAgent(env, owner, prompt);
    const persisted = await env.json(`/api/sessions/${owner.id}`);
    assert.equal(persisted.threadId, result.session.threadId);
    assert.equal(persisted.turns.find(turn => turn.id === result.turn.id)?.prompt, prompt,
      'Original session did not persist its private user message');
    assert.equal((await env.json(fileURL(a, filename))).trim(), markerA);
    assert.equal((await health(first)).marker, markerA);
    return { threadId: result.session.threadId };
  });
  await env.step('A sibling session reads the shared file but has a separate transcript', async () => {
    const path = `${a.workingDirectory}/${filename}`;
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = `node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))' ${quote(path)}`;
    const prompt = `请核对这个项目中已有文件的实际内容。必须使用 exec_command 执行以下只读命令：
${command}
必须等命令完成，读取失败则报告真实错误。不要猜测内容，不要只确认收到任务。不要修改文件，不要使用子代理或外部服务。`;
    const result = await runAgent(env, peer, prompt);
    env.report.sharedReadEvidence = { prompt, threadId: result.session.threadId, turn: result.turn };
    await env.persist();
    const reads = result.turn.items.filter(item => item.type === 'command_execution');
    assert(reads.length > 0, `Sibling agent did not execute a file read; reply: ${env.redact(result.text).slice(0, 1000)}`);
    assert(reads.some(item => item.status === 'completed' && item.exit_code === 0
      && item.command.includes(filename) && item.aggregated_output.includes(markerA)), 'Sibling file-read command did not return the stored content');
    assert(!result.turn.items.some(item => item.type === 'file_change'), 'Sibling read modified the workspace');
    assert.equal((await env.json(fileURL(a, filename))).trim(), markerA, 'Sibling read changed the shared file');
    assert(!JSON.stringify(result.session.turns).includes(privateMarker), 'Sibling transcript contains private conversation');
    const original = await env.json(`/api/sessions/${owner.id}`);
    assert(original.turns.some(turn => turn.prompt.includes(privateMarker)), 'Original private message disappeared');
    assert.notEqual(original.threadId, result.session.threadId);
    assert(events.messages.every(message => message.type !== 'sdk'), 'Another project received first-project execution events');
    assert(events.messages.every(message => !message.session || message.session.id === other.id), 'SSE snapshot contains another session');
    return { ownerThread: original.threadId, peerThread: result.session.threadId };
  });
  await env.step('Another project has no first-project file or history and owns its own content', async () => {
    const result = await runAgent(env, other, `Use Node to assert ${filename} does not exist, then write it containing exactly ${markerB}. ${servicePrompt(markerB)} Do not use subagents or external systems.`);
    for (const session of [owner, peer]) {
      assert.notEqual((await env.json(`/api/sessions/${session.id}`)).threadId, result.session.threadId,
        'Projects share a conversation thread');
    }
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
