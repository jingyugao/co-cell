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
  const history = current => current.turns.map(turn => ({ nativeTurnId: turn.nativeTurnId ?? turn.id, prompt: turn.prompt,
    status: turn.status, replies: turn.items.filter(item => item.type === 'agent_message').map(item => item.text) }));
  const record = async () => {
    const prompt = `这是用于故障恢复验证的会话记录 ${randomUUID()}。只需简短确认收到，不要调用工具、读写文件或创建子代理。`;
    const result = await runAgent(env, session, prompt);
    assert.equal(result.turn.prompt, prompt);
    assert(result.turn.nativeTurnId, 'Missing persisted native turn');
    assert(result.text.trim(), 'Agent did not complete a real conversation');
    return result;
  };
  await env.step('Prepare a workspace file and real conversation, then Checkpoint and pause the Sandbox', async () => {
    await write(filename, before);
    assert.equal(await read(), before);
    initial = await record();
    const checkpointResponse = await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', body: {}, expectedStatus: 200, timeoutMs: env.config.operationTimeout });
    assert.equal(checkpointResponse.sandboxOperation.status, 'succeeded');
    assert.equal(checkpointResponse.sandbox.status, 'paused');
    const paused = await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused' });
    assert.equal(paused.sandbox.id, ready.sandbox.id);
    return { sandboxId: paused.sandbox.id, status: paused.sandbox.status };
  });
  await env.step('Back up the paused workspace and verify its archive', async () => {
    const response = await env.json(`/api/projects/${project.id}/backup`, { method: 'POST', expectedStatus: 200,
      timeoutMs: env.config.operationTimeout });
    assert.equal(response.sandboxOperation.kind, 'backup');
    assert.equal(response.sandboxOperation.status, 'succeeded');
    const backedUp = await env.waitProject(project.id, { kind: 'backup', status: 'paused' });
    assert.equal(backedUp.sandboxBackup?.status, 'succeeded');
    archive = backedUp.remoteArchives?.[0];
    assert(archive, 'Backup did not publish a workspace archive');
    assert(archive.sizeBytes > 0 && archive.threadIds.includes(initial.session.threadId));
    return { archiveId: archive.id, threadId: initial.session.threadId };
  });
  await env.step('Activate the restored archive before adding newer data', async () => {
    const archived = await env.json(`/api/projects/${project.id}/archive`, {
      method: 'POST', body: { useExistingBackup: true }, expectedStatus: 200, timeoutMs: env.config.operationTimeout,
    });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.sandboxOperation.status, 'succeeded');
    assert.equal(archived.sandbox, undefined);
    const restoredNow = await env.json(`/api/projects/${project.id}/sandbox/restore`, { method: 'POST', body: {}, expectedStatus: 200, timeoutMs: env.config.operationTimeout });
    assert.equal(restoredNow.sandboxOperation.status, 'succeeded');
    assert.equal(restoredNow.sandboxOperation.kind, 'restore');
    assert.equal(restoredNow.sandbox.status, 'ready');
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
  await env.step('Report same-ID rebuild as unsupported while preserving the original binding and backup', async () => {
    const failure = await failTestSandbox(env, project.id);
    await env.waitProject(project.id, { status: 'unavailable' });
    const rejected = await env.json(`/api/projects/${project.id}/sandbox/rebuild`, {
      method: 'POST', body: {}, expectedStatus: 422, timeoutMs: env.config.operationTimeout,
    });
    assert.match(rejected.error, /不支持同 ID 重建/);
    const current = await env.json(`/api/projects/${project.id}`);
    assert.equal(current.sandbox.id, ready.sandbox.id);
    assert.equal(current.remoteArchives[0].id, archive.id);
    assert.equal(current.sandboxOperation.status, 'failed');
    env.report.homeRebuildEvidence.sameIdRebuildUnsupported = true;
    await env.persist();
    return { ...failure, sandboxId: current.sandbox.id, archiveId: archive.id };

  });
}
