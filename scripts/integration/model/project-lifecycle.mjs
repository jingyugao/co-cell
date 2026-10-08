import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

// Real model journey: all guest files and processes must be created through CoCell turns.
export async function projectLifecycle(env) {
  const { model, operationTimeout, turnTimeout } = env.config;
  const report = env.report;
  const json = env.json.bind(env), request = env.request.bind(env), step = env.step.bind(env);
  const redact = env.redact.bind(env), persist = env.persist.bind(env);
  const delay = ms => sleep(ms, undefined, { signal: env.controller.signal });
  let projectId, sessionId, threadId, originalSandboxId, workingDirectory;
  const waitProject = (kind, status) => env.waitProject(projectId, { kind, status });
  const waitIdle = () => env.waitIdle(projectId);
  const port = 18080;
  const folder = 'lifecycle-http';
  const marker = `service-${randomUUID()}`;
  const memory = `conversation-${randomUUID()}`;
  const initialContent = `created-${randomUUID()}`;
  const resumedContent = `resumed-${randomUUID()}`;
  const restoredContent = `restored-${randomUUID()}`;

  async function turn(prompt) {
    const { turnId } = await json(`/api/sessions/${sessionId}/turns`, { method: 'POST', body: { prompt, images: [] }, expectedStatus: 202 });
    const deadline = Date.now()+turnTimeout;
    let previous;
    while (Date.now() < deadline) {
      const session = await json(`/api/sessions/${sessionId}`, { timeoutMs: 60_000 });
      const current = session.turns.find(t => t.id === turnId || t.nativeTurnId === turnId || t.prompt === prompt);
      if (current) {
        const progress = `${current.status}/${current.phase ?? ''}/${current.items.length}`;
        if (progress !== previous) { console.log(`    turn ${progress}`); previous = progress; }
        if (current.status !== 'running') {
          assert.equal(current.status, 'completed', redact(current.error ?? `Turn ended as ${current.status}`));
          assert.equal(session.settings.model, model, 'Model changed during the test');
          assert(session.threadId, 'App Server did not create a native conversation thread');
          if (threadId) assert.equal(session.threadId, threadId, 'Conversation thread changed across lifecycle operation');
          else { threadId = session.threadId; report.threadId = threadId; }
          await waitIdle();
          const text = current.items.filter(item => item.type === 'agent_message').map(item => item.text).join('\n');
          return { text, turnId: current.id, nativeTurnId: current.nativeTurnId,
            commands: current.items.filter(item => item.type === 'command_execution').length,
            model: session.contextUsage?.model ?? session.settings.model, turnCount: session.turnCount };
        }
      }
      await delay(2000);
    }
    // Stop this test's turn; the fixture records evidence and cleans up its project.
    await json(`/api/sessions/${sessionId}/stop`, { method: 'POST', body: {} }).catch(() => {});
    throw new Error(`Conversation timed out; inspect session ${sessionId}`);
  }
  async function textFile(name, expected) {
    const path = `${workingDirectory}/${folder}/${name}`;
    const url = `/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`;
    const { data: text } = await request(url);
    if (expected !== undefined) assert.equal(text.trim(), expected);
    const { response: head } = await request(url, { method: 'HEAD' });
    const size = Number(head.headers.get('content-length'));
    assert.equal(size, Buffer.byteLength(text));
    return { path, sha256: createHash('sha256').update(text).digest('hex'), size, text };
  }
  async function health(expectedContent) {
    const challenge = randomUUID();
    const result = await json(`/api/projects/${projectId}/service/${port}/healthz?challenge=${challenge}`);
    assert.equal(result.marker, marker);
    assert.equal(result.challenge, challenge, 'HTTP response did not reach the current Node service');
    assert.equal(result.continuity, expectedContent);
    assert.equal(typeof result.instance, 'string'); assert(result.instance.length >= 16);
    assert(Number.isSafeInteger(result.pid) && result.pid > 0);
    assert(Number.isSafeInteger(result.counter) && result.counter > 0);
    return result;
  }
  function checkSameProcess(before, after) {
    assert.equal(after.instance, before.instance, 'Checkpoint/resume restarted the Node service');
    assert.equal(after.pid, before.pid, 'Node PID changed after checkpoint/resume');
    assert(after.counter > before.counter, 'HTTP request counter did not survive checkpoint/resume');
  }

  await step('Create project and wait for its sandbox to become ready', async () => {
    const config = await json('/api/config'); assert.equal(config.sandbox?.enabled, true);
    const project = await env.createProject('lifecycle');
    projectId = report.projectId = project.id;
    assert.equal(project.sandboxOperation?.kind, 'create');
    const ready = await waitProject('create', 'ready'); originalSandboxId = report.originalSandboxId = ready.sandbox.id;
    workingDirectory = ready.workingDirectory;
    console.log(`    project ${projectId}; sandbox ${originalSandboxId}`);
    return { projectId, sandboxId: originalSandboxId, image: ready.sandbox.image?.id };
  });
  await step('Create a model conversation and ask the agent to build/start Node HTTP', async () => {
    const session = await json('/api/sessions', { method: 'POST', body: { projectId, title: 'Node HTTP lifecycle integration',
      settings: { model, modelReasoningEffort: 'low', webSearchMode: 'disabled' } }, expectedStatus: 201 });
    sessionId = report.sessionId = session.id; await persist(); assert.equal(session.settings.model, model);
    const result = await turn(`这是平台集成测试，请直接执行，不要只提供代码。只修改工作目录下 ${folder}/，不读写凭证，不安装或下载软件，不使用子 agent。
只在对话中记住验证码 ${memory}，不要把这个验证码写入任何文件。后续会检验你是否记得。
使用预装 Node.js 标准库（node:http、node:fs、node:crypto），编写 ${folder}/main.mjs 和启动脚本 ${folder}/start.mjs，不依赖 npm 包。创建 continuity.txt，内容为 ${initialContent} 加换行。
服务仅监听 127.0.0.1:${port}。GET /healthz 返回 JSON：marker 固定为 ${marker}；instance 是本进程启动时 crypto.randomUUID() 生成的随机标识，启动后不变；pid 是 process.pid；counter 是从1开始递增的内存请求计数；challenge 回显 URL 中的 challenge 参数；continuity 每次请求读取当前 continuity.txt 并去掉首尾空白。
先用 node --check 检查 main.mjs，再编写 start.mjs，用 child_process.spawn(process.execPath, ['main.mjs'], ...) 启动服务，cwd 为 ${folder} 的绝对路径，detached:true，stdin忽略，stdout/stderr写到该目录的 server.log，child.unref()。执行这个启动脚本，使服务在本轮对话结束后持续运行，不要用前台长时间阻塞的命令启动。
实际访问 http://127.0.0.1:${port}/healthz 验证启动成功，然后简短汇报。`);
    assert(result.commands > 0, 'Agent did not execute any tool commands');
    return { sessionId, threadId, ...result };
  });
  {
    let source, firstHealth;
    await step('Verify workspace file API, raw downloads, and proxied Node HTTP', async () => {
      source = await textFile('main.mjs'); assert(source.text.includes('createServer'));
      await textFile('start.mjs'); const file = await textFile('continuity.txt', initialContent);
      firstHealth = await health(initialContent); const next = await health(initialContent); checkSameProcess(firstHealth, next); firstHealth = next;
      return { sourceSha256: source.sha256, fileSha256: file.sha256, http: firstHealth };
    });
    await step('Checkpoint the sandbox and verify access cannot silently resume it', async () => {
      await json(`/api/projects/${projectId}/sandbox/checkpoint`, { method: 'POST', body: {}, expectedStatus: 202 });
      const paused = await waitProject('checkpoint', 'paused'); assert.equal(paused.sandbox.id, originalSandboxId);
      const inventory = await json('/api/sandboxes'); assert.equal(inventory.sandboxes.find(s => s.id === originalSandboxId)?.state, 'paused');
      const { response: blocked } = await request(`/api/projects/${projectId}/service/${port}/healthz`, { expectedStatus: 409 }); assert.equal(blocked.status, 409, 'Paused sandbox allowed HTTP access');
      assert.equal((await json(`/api/projects/${projectId}`)).sandbox.status, 'paused');
      return { sandboxId: originalSandboxId, status: paused.sandbox.status, blockedHttpStatus: blocked.status };
    });
    await step('Resume and verify the same Node process, files, and in-memory counter survived', async () => {
      await json(`/api/projects/${projectId}/sandbox/resume`, { method: 'POST', body: {}, expectedStatus: 202 });
      const resumed = await waitProject('resume', 'ready'); assert.equal(resumed.sandbox.id, originalSandboxId);
      assert.equal((await textFile('main.mjs')).sha256, source.sha256); await textFile('continuity.txt', initialContent);
      const current = await health(initialContent); checkSameProcess(firstHealth, current); firstHealth = current;
      return { sandboxId: resumed.sandbox.id, http: current };
    });
    await step('Continue the original conversation after resume and change the served file', async () => {
      const result = await turn(`请继续原来的任务，回复中包含首次告诉你的、只存在于对话里的验证码，以确认上下文仍在。不要重新启动或修改 HTTP 服务。只把 ${folder}/continuity.txt 改为 ${resumedContent} 加换行，然后访问服务确认它能读到新值。`);
      assert(result.text.includes(memory), 'Conversation context was lost after resume');
      await textFile('continuity.txt', resumedContent); const current = await health(resumedContent); checkSameProcess(firstHealth, current);
      return { ...result, threadId, http: current };
    });
    let backup;
    await step('Back up the project with the conversation thread and workspace', async () => {
      const project = await json(`/api/projects/${projectId}/backup`, { method: 'POST', body: {}, expectedStatus: 202, timeoutMs: operationTimeout });
      assert.equal(project.sandboxOperation.status, 'succeeded'); backup = project.remoteArchives?.[0];
      assert(backup && backup.sizeBytes > 0 && /^[a-f0-9]{64}$/.test(backup.sha256));
      assert.equal(backup.sourceSandboxId, originalSandboxId); assert(backup.threadIds.includes(threadId));
      return { archiveId: backup.id, sizeBytes: backup.sizeBytes, sha256: backup.sha256, threadIds: backup.threadIds };
    });
    await step('Change the live workspace after backup so restore must roll it back', async () => {
      const unbackedContent = `not-in-backup-${randomUUID()}`;
      const result = await turn(`Do not restart the service. Change only ${folder}/continuity.txt to ${unbackedContent} plus newline. Do not create another backup. Verify the running HTTP service reads this new value.`);
      assert(result.commands > 0);
      await textFile('continuity.txt', unbackedContent);
      const current = await health(unbackedContent); checkSameProcess(firstHealth, current);
      return { archiveId: backup.id, unbackedContent, http: current };
    });
    await step('Complete a checkpointed project without resuming it', async () => {
      await json(`/api/projects/${projectId}/sandbox/checkpoint`, { method: 'POST', body: {}, expectedStatus: 202 });
      await waitProject('checkpoint', 'paused');
      const completed = await json(`/api/projects/${projectId}`, { method: 'PATCH', body: { status: 'completed' } });
      assert.equal(completed.status, 'completed'); assert.equal(completed.sandbox.status, 'paused');
      assert.equal(completed.sandbox.id, originalSandboxId);
      return { sandboxId: originalSandboxId, completedAt: completed.completedAt };
    });
    await step('Clean up the checkpointed project using its existing archive', async () => {
      const previousArchiveId = backup.id;
      const archived = await json(`/api/projects/${projectId}/archive`, { method: 'POST', body: { useExistingBackup: true }, expectedStatus: 202, timeoutMs: operationTimeout });
      assert.equal(archived.status, 'archived'); assert.equal(archived.sandbox, undefined);
      assert.equal(archived.sandboxOperation.status, 'succeeded'); assert(!archived.pendingSandboxCleanup?.length, 'Sandbox deletion is still pending');
      backup = archived.remoteArchives[0]; assert(backup.threadIds.includes(threadId));
      assert.equal(backup.id, previousArchiveId, 'Paused cleanup created a new archive');
      const inventory = await json('/api/sandboxes'); assert(!inventory.sandboxes.some(s => s.id === originalSandboxId), 'Original sandbox still exists');
      return { deletedSandboxId: originalSandboxId, archiveId: backup.id };
    });
    await step('Rebuild from backup and verify restored files and original conversation history', async () => {
      await json(`/api/projects/${projectId}/sandbox/rebuild`, { method: 'POST', body: {}, expectedStatus: 202 });
      const restored = await waitProject('restore', 'ready'); assert.equal(restored.status, 'active');
      assert.notEqual(restored.sandbox.id, originalSandboxId); report.restoredSandboxId = restored.sandbox.id;
      assert.equal((await textFile('main.mjs')).sha256, source.sha256); await textFile('start.mjs'); await textFile('continuity.txt', resumedContent);
      const session = await json(`/api/sessions/${sessionId}`); assert.equal(session.threadId, threadId);
      assert(session.turns.some(t => t.prompt.includes(memory)), 'Original conversation history is missing from backup');
      const { response } = await request(`/api/projects/${projectId}/service/${port}/healthz`, { expectedStatus: [502, 503, 504] }); assert([502, 503, 504].includes(response.status), `Archive restore unexpectedly preserved a process, or gateway failed with ${response.status}`);
      return { sandboxId: restored.sandbox.id, sourceSha256: source.sha256, threadId, httpBeforeRestart: response.status };
    });
    await step('Continue the same conversation after restore and ask the agent to restart Node HTTP', async () => {
      const result = await turn(`项目已从备份重建。请继续原会话，回复中包含首次告诉你的、只存在于对话里的验证码。读取 ${folder}/continuity.txt 确认上一轮的修改还在。不要重新编写 main.mjs，不要下载或安装软件。用已有 ${folder}/start.mjs 重新启动 HTTP 服务；只把 continuity.txt 改为 ${restoredContent} 加换行，然后实际访问 /healthz 验证。`);
      assert(result.text.includes(memory), 'Conversation context was lost after backup restore');
      assert(result.commands > 0, 'Agent did not execute the restart');
      return { ...result, threadId };
    });
    await step('Verify restored workspace downloads and the restarted HTTP service', async () => {
      assert.equal((await textFile('main.mjs')).sha256, source.sha256); const file = await textFile('continuity.txt', restoredContent);
      const current = await health(restoredContent); assert.notEqual(current.instance, firstHealth.instance, 'Node process was not restarted in the new sandbox');
      const session = await json(`/api/sessions/${sessionId}`); assert.equal(session.threadId, threadId); assert(session.turnCount >= 3);
      return { sandboxId: report.restoredSandboxId, sourceSha256: source.sha256, fileSha256: file.sha256, http: current, turnCount: session.turnCount };
    });
  }
}
