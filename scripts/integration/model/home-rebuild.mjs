import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConversation, fileURL, runAgent } from '../support/agent.mjs';
import { failTestSandbox, testWorkspaceWriter } from '../support/kubernetes.mjs';

export async function homeRebuild(env) {
  const project = await env.createProject('home-rebuild');
  let ready = await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  const session = await createConversation(env, project, 'Mounted HOME recovery');
  const write = await testWorkspaceWriter(env, project.id);
  const filename = `recovery-${randomUUID()}.txt`;
  const before = `before-backup-${randomUUID()}\n`, latest = `after-backup-${randomUUID()}\n`;
  let archive, initial, newer, savedHistory;
  const read = () => env.json(fileURL(ready, filename));
  const history = current => current.turns.map(turn => ({ nativeTurnId: turn.nativeTurnId, prompt: turn.prompt,
    status: turn.status, replies: turn.items.filter(item => item.type === 'agent_message').map(item => item.text) }));
  const record = async () => {
    const prompt = `这是用于故障恢复验证的会话记录 ${randomUUID()}。只需简短确认收到，不要调用工具、读写文件或创建子代理。`;
    const result = await runAgent(env, session, prompt);
    assert.equal(result.turn.prompt, prompt);
    assert(result.turn.nativeTurnId, 'Missing persisted native turn');
    assert(result.text.trim(), 'Agent did not complete a real conversation');
    assert(!result.turn.items.some(item => ['command_execution', 'file_change', 'mcp_tool_call'].includes(item.type)));
    return result;
  };
  await env.step('Prepare a workspace file and real conversation, then capture an archive', async () => {
    await write(filename, before);
    assert.equal(await read(), before);
    initial = await record();
    const backedUp = await env.json(`/api/projects/${project.id}/backup`, {
      method: 'POST', body: {}, expectedStatus: 202, timeoutMs: env.config.operationTimeout,
    });
    assert.equal(backedUp.sandboxOperation.status, 'succeeded');
    archive = backedUp.remoteArchives[0];
    assert(archive.sizeBytes > 0 && archive.threadIds.includes(initial.session.threadId));
    return { archiveId: archive.id, threadId: initial.session.threadId };
  });
  await env.step('Activate the restored archive before adding newer data', async () => {
    await env.json(`/api/projects/${project.id}/archive`, {
      method: 'POST', body: { useExistingBackup: true }, expectedStatus: 202, timeoutMs: env.config.operationTimeout,
    });
    await env.json(`/api/projects/${project.id}/sandbox/rebuild`, { method: 'POST', body: {}, expectedStatus: 202 });
    const restored = await env.waitProject(project.id, { kind: 'restore', status: 'ready' });
    assert.notEqual(restored.sandbox.id, ready.sandbox.id);
    ready = restored;
    assert.equal(await read(), before);
    const current = await env.json(`/api/sessions/${session.id}`);
    assert.equal(current.threadId, initial.session.threadId);
    assert.deepEqual(history(current), history(initial.session));
    return { sandboxId: ready.sandbox.id };
  });
  await env.step('Persist a file and native conversation newer than the archive', async () => {
    await write(filename, latest);
    newer = await record();
    assert.equal(newer.session.threadId, initial.session.threadId);
    assert.equal(await read(), latest);
    savedHistory = history(await env.json(`/api/sessions/${session.id}`));
    assert(savedHistory.some(turn => turn.nativeTurnId === initial.turn.nativeTurnId));
    assert(savedHistory.some(turn => turn.nativeTurnId === newer.turn.nativeTurnId));
    env.report.homeRebuildEvidence = { filename, before, latest, archiveId: archive.id, savedHistory };
    await env.persist();
    return { nativeTurnId: newer.turn.nativeTurnId };
  });
  await env.step('Lose the test execution and rebuild the same HOME without archive rollback', async () => {
    const failure = await failTestSandbox(env, project.id);
    await env.waitProject(project.id, { status: 'unavailable' });
    await env.json(`/api/projects/${project.id}/sandbox/rebuild`, { method: 'POST', body: {}, expectedStatus: 202 });
    const rebuilt = await env.waitProject(project.id, { kind: 'rebuild', status: 'ready' });
    assert.equal(rebuilt.sandbox.id, ready.sandbox.id, 'Rebuild replaced the HOME owner');
    assert.equal(rebuilt.remoteArchives[0].id, archive.id);
    assert.equal(await read(), latest, 'Rebuild lost the file written after backup');
    const current = await env.json(`/api/sessions/${session.id}`);
    assert.equal(current.threadId, initial.session.threadId);
    assert.deepEqual(history(current), savedHistory, 'Rebuild lost or changed native conversation history');
    const continued = await record();
    assert.equal(continued.session.threadId, initial.session.threadId);
    assert.deepEqual(history(continued.session).slice(0, savedHistory.length), savedHistory);
    assert.equal(history(continued.session).length, savedHistory.length + 1);
    assert.equal(await read(), latest);
    return { ...failure, sandboxId: rebuilt.sandbox.id, threadId: current.threadId, turns: continued.session.turns.length };
  });
}
