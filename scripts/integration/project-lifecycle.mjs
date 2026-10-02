import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Opt-in live integration test: no mocks, direct guest commands, or fixture files.
// Run with COCELL_E2E_BASE_URL and COCELL_E2E_ACCESS_TOKEN, via pnpm test:integration.
// Keep the project for inspection with COCELL_E2E_KEEP_PROJECT=1.
const token = process.env.COCELL_E2E_ACCESS_TOKEN;
const base = new URL(process.env.COCELL_E2E_BASE_URL ?? 'http://127.0.0.1:3001');
assert(token, 'COCELL_E2E_ACCESS_TOKEN is required');
assert(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash,
  'COCELL_E2E_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const model = 'gpt-6-luna';
const port = 18080;
const folder = 'lifecycle-http';
const marker = `service-${randomUUID()}`;
const memory = `conversation-${randomUUID()}`;
const initialContent = `created-${randomUUID()}`;
const resumedContent = `resumed-${randomUUID()}`;
const restoredContent = `restored-${randomUUID()}`;
const output = resolve(process.env.COCELL_E2E_REPORT ?? `tmp/integration/${runId}.json`);
const operationTimeout = Number(process.env.COCELL_E2E_OPERATION_TIMEOUT_MS ?? 300_000);
const turnTimeout = Number(process.env.COCELL_E2E_TURN_TIMEOUT_MS ?? 600_000);
assert(Number.isSafeInteger(operationTimeout) && operationTimeout > 0, 'Invalid operation timeout');
assert(Number.isSafeInteger(turnTimeout) && turnTimeout > 0, 'Invalid turn timeout');
const report = { runId, baseUrl: base.origin, model, startedAt: new Date().toISOString(), status: 'running', steps: [] };
let projectId, sessionId, threadId, originalSandboxId, workingDirectory;
const redact = value => String(value).replaceAll(token, '[redacted]');
const persist = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)+'\n', { mode: 0o600 }); };

async function request(path, { method = 'GET', body, timeoutMs = 30_000, expectedStatus = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method, headers: { Authorization: `Bearer ${token}`, Origin: base.origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text(); // Drain responses to release service/usage leases before checkpoint.
  const data = method !== 'HEAD' && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
  if (response.status !== expectedStatus) throw new Error(redact(`${method} ${path}: HTTP ${response.status}; ${JSON.stringify(data).slice(0, 800)}`));
  return { data, response };
}
async function json(path, options) { return (await request(path, options)).data; }
async function step(name, run) {
  const entry = { name, startedAt: new Date().toISOString(), status: 'running' };
  report.steps.push(entry); await persist(); console.log(`[${report.steps.length}] ${name}`);
  const start = Date.now();
  try { entry.evidence = await run(); entry.status = 'passed'; }
  catch (error) { entry.status = 'failed'; entry.error = redact(error.message); throw error; }
  finally { entry.durationMs = Date.now()-start; await persist(); }
  console.log(`    PASS (${entry.durationMs} ms)`);
}
async function waitProject(kind, status) {
  const deadline = Date.now()+operationTimeout;
  let previous;
  while (Date.now() < deadline) {
    const project = await json(`/api/projects/${projectId}`);
    const operation = project.sandboxOperation;
    assert.equal(operation?.kind, kind, 'Unexpected project operation');
    const phase = `${operation.status}: ${operation.phase}`;
    if (phase !== previous) { console.log(`    ${phase}`); previous = phase; }
    if (operation.status === 'failed') throw new Error(`${kind} failed: ${operation.error}`);
    if (operation.status === 'succeeded') {
      if (status) assert.equal(project.sandbox?.status, status);
      return project;
    }
    await delay(1500);
  }
  throw new Error(`${kind} timed out; inspect project ${projectId} before retrying`);
}
async function waitIdle() {
  const deadline = Date.now()+30_000;
  while (Date.now() < deadline) {
    if (!(await json(`/api/projects/${projectId}`)).activeSessionId) return;
    await delay(300);
  }
  throw new Error('Project still has an active conversation');
}
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
  // Stop only this test's turn; preserve the project and report for investigation.
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
  assert.equal(result.challenge, challenge, 'HTTP response did not reach the current Go service');
  assert.equal(result.continuity, expectedContent);
  assert.equal(typeof result.instance, 'string'); assert(result.instance.length >= 16);
  assert(Number.isSafeInteger(result.pid) && result.pid > 0);
  assert(Number.isSafeInteger(result.counter) && result.counter > 0);
  return result;
}
function checkSameProcess(before, after) {
  assert.equal(after.instance, before.instance, 'Checkpoint/resume restarted the Go service');
  assert.equal(after.pid, before.pid, 'Go PID changed after checkpoint/resume');
  assert(after.counter > before.counter, 'HTTP request counter did not survive checkpoint/resume');
}

try {
  await step('Create project and wait for its sandbox to become ready', async () => {
    const config = await json('/api/config'); assert.equal(config.sandbox?.enabled, true);
    const project = await json('/api/projects', { method: 'POST', body: { name: `Integration ${runId}`, type: 1 }, expectedStatus: 201 });
    projectId = report.projectId = project.id;
    assert.equal(project.sandboxOperation?.kind, 'create');
    const ready = await waitProject('create', 'ready'); originalSandboxId = report.originalSandboxId = ready.sandbox.id;
    workingDirectory = ready.workingDirectory;
    console.log(`    project ${projectId}; sandbox ${originalSandboxId}`);
    return { projectId, sandboxId: originalSandboxId, image: ready.sandbox.image?.id };
  });
  await step('Create a gpt-6-luna conversation and ask the agent to build/start Go HTTP', async () => {
    const session = await json('/api/sessions', { method: 'POST', body: { projectId, title: 'Go HTTP lifecycle integration',
      settings: { model, modelReasoningEffort: 'low', webSearchMode: 'disabled' } }, expectedStatus: 201 });
    sessionId = report.sessionId = session.id; await persist(); assert.equal(session.settings.model, model);
    const result = await turn(`这是平台集成测试，请直接执行，不要只提供代码。只修改工作目录下 ${folder}/，不读写凭证，不安装或下载软件，不使用子 agent。
只在对话中记住验证码 ${memory}，不要把这个验证码写入任何文件。后续会检验你是否记得。
使用预装 Go（/usr/local/go/bin/go），用标准库编写 ${folder}/main.go 和启动脚本 ${folder}/start.mjs。不要依赖任何外部 Go 模块。创建 continuity.txt，内容为 ${initialContent} 加换行。
服务仅监听 127.0.0.1:${port}。使用 http.HandleFunc("/healthz", handler) 注册路由（不要用 "GET /healthz" 模式，以兼容 GO111MODULE=off），在 handler 内检查 GET 方法。GET /healthz 返回 JSON：marker 固定为 ${marker}；instance 是本进程启动时生成的至少16字符随机标识，启动后不变；pid 是 os.Getpid()；counter 是从1开始递增的请求计数；challenge 回显 URL 中的 challenge 参数；continuity 每次请求读取当前 continuity.txt 并去掉首尾空白。
使用 GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GO111MODULE=off /usr/local/go/bin/go build 将二进制生成在 ${folder}/server。务必等待构建命令退出码0并确认二进制存在，再启动；如果首次编译较慢，请持续等待同一个命令完成，不要重复并行构建。编写 start.mjs，使用 Node child_process.spawn 启动这个二进制，cwd 为 ${folder} 的绝对路径，detached:true，stdin忽略，stdout/stderr写到该目录的 server.log，child.unref()。用 /usr/local/bin/node 启动脚本，使服务在本轮对话结束后持续运行。不要使用 go run。
实际访问 http://127.0.0.1:${port}/healthz 验证启动成功，然后简短汇报。`);
    assert(result.commands > 0, 'Agent did not execute any tool commands');
    return { sessionId, threadId, ...result };
  });
  await step('Ask the agent to use request_user_input_async and answer from the API', async () => {
    const prompt = `这是平台集成测试。必须调用 request_user_input_async，发送一个问题“集成测试继续吗？”并提供两个选项“继续”和“停止”。不要把问题当普通文字输出。调用成功后简短汇报。`;
    const result = await turn(prompt);
    const session = await json(`/api/sessions/${sessionId}`);
    const source = session.turns.find(t => t.id === result.turnId || t.nativeTurnId === result.nativeTurnId);
    assert(source?.userInputRequests?.length, 'request_user_input_async did not create a persisted request');
    const request = source.userInputRequests.at(-1);
    assert.equal(request.status, 'pending');
    const answered = await json(`/api/sessions/${sessionId}/turns/${source.id}/user-input/${request.id}`, {
      method: 'POST', body: { answer: '继续' }, expectedStatus: 200,
    });
    const updated = answered.turns.find(t => t.id === source.id);
    assert.equal(updated?.userInputRequests?.at(-1)?.status, 'answered');
    assert(updated.userInputRequests.at(-1).answerTurnId, 'answer turn was not created');
    await waitIdle();
    return { requestId: request.id, answerTurnId: updated.userInputRequests.at(-1).answerTurnId };
  });
  let source, firstHealth;
  await step('Verify workspace file API, raw downloads, and proxied Go HTTP', async () => {
    source = await textFile('main.go'); assert(source.text.includes('package main'));
    await textFile('start.mjs'); const file = await textFile('continuity.txt', initialContent);
    firstHealth = await health(initialContent); const next = await health(initialContent); checkSameProcess(firstHealth, next); firstHealth = next;
    return { sourceSha256: source.sha256, fileSha256: file.sha256, http: firstHealth };
  });
  await step('Checkpoint the sandbox and verify access cannot silently resume it', async () => {
    await json(`/api/projects/${projectId}/sandbox/checkpoint`, { method: 'POST', body: {}, expectedStatus: 202 });
    const paused = await waitProject('checkpoint', 'paused'); assert.equal(paused.sandbox.id, originalSandboxId);
    const inventory = await json('/api/sandboxes'); assert.equal(inventory.sandboxes.find(s => s.id === originalSandboxId)?.state, 'paused');
    const blocked = await fetch(new URL(`/api/projects/${projectId}/service/${port}/healthz`, base), { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    await blocked.arrayBuffer(); assert.equal(blocked.status, 409, 'Paused sandbox allowed HTTP access');
    assert.equal((await json(`/api/projects/${projectId}`)).sandbox.status, 'paused');
    return { sandboxId: originalSandboxId, status: paused.sandbox.status, blockedHttpStatus: blocked.status };
  });
  await step('Resume and verify the same Go process, files, and in-memory counter survived', async () => {
    await json(`/api/projects/${projectId}/sandbox/resume`, { method: 'POST', body: {}, expectedStatus: 202 });
    const resumed = await waitProject('resume', 'ready'); assert.equal(resumed.sandbox.id, originalSandboxId);
    assert.equal((await textFile('main.go')).sha256, source.sha256); await textFile('continuity.txt', initialContent);
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
  await step('Archive the project and confirm the original sandbox was deleted', async () => {
    const archived = await json(`/api/projects/${projectId}/archive`, { method: 'POST', body: { useExistingBackup: true }, expectedStatus: 202, timeoutMs: operationTimeout });
    assert.equal(archived.status, 'archived'); assert.equal(archived.sandbox, undefined);
    assert.equal(archived.sandboxOperation.status, 'succeeded'); assert(!archived.pendingSandboxCleanup?.length, 'Sandbox deletion is still pending');
    backup = archived.remoteArchives[0]; assert(backup.threadIds.includes(threadId));
    const inventory = await json('/api/sandboxes'); assert(!inventory.sandboxes.some(s => s.id === originalSandboxId), 'Original sandbox still exists');
    return { deletedSandboxId: originalSandboxId, archiveId: backup.id };
  });
  await step('Rebuild from backup and verify restored files and original conversation history', async () => {
    await json(`/api/projects/${projectId}/sandbox/rebuild`, { method: 'POST', body: {}, expectedStatus: 202 });
    const restored = await waitProject('restore', 'ready'); assert.equal(restored.status, 'active');
    assert.notEqual(restored.sandbox.id, originalSandboxId); report.restoredSandboxId = restored.sandbox.id;
    assert.equal((await textFile('main.go')).sha256, source.sha256); await textFile('start.mjs'); await textFile('continuity.txt', resumedContent);
    const session = await json(`/api/sessions/${sessionId}`); assert.equal(session.threadId, threadId);
    assert(session.turns.some(t => t.prompt.includes(memory)), 'Original conversation history is missing from backup');
    const response = await fetch(new URL(`/api/projects/${projectId}/service/${port}/healthz`, base), { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    await response.arrayBuffer(); assert([502, 503, 504].includes(response.status), `Archive restore unexpectedly preserved a process, or gateway failed with ${response.status}`);
    return { sandboxId: restored.sandbox.id, sourceSha256: source.sha256, threadId, httpBeforeRestart: response.status };
  });
  await step('Continue the same conversation after restore and ask the agent to restart Go HTTP', async () => {
    const result = await turn(`项目已从备份重建。请继续原会话，回复中包含首次告诉你的、只存在于对话里的验证码。读取 ${folder}/continuity.txt 确认上一轮的修改还在。不要重新编写 main.go，不要下载或安装软件。用已有 ${folder}/start.mjs 重新启动 HTTP 服务；只把 continuity.txt 改为 ${restoredContent} 加换行，然后实际访问 /healthz 验证。`);
    assert(result.text.includes(memory), 'Conversation context was lost after backup restore');
    assert(result.commands > 0, 'Agent did not execute the restart');
    return { ...result, threadId };
  });
  await step('Verify restored workspace downloads and the restarted HTTP service', async () => {
    assert.equal((await textFile('main.go')).sha256, source.sha256); const file = await textFile('continuity.txt', restoredContent);
    const current = await health(restoredContent); assert.notEqual(current.instance, firstHealth.instance, 'Go process was not restarted in the new sandbox');
    const session = await json(`/api/sessions/${sessionId}`); assert.equal(session.threadId, threadId); assert(session.turnCount >= 3);
    return { sandboxId: report.restoredSandboxId, sourceSha256: source.sha256, fileSha256: file.sha256, http: current, turnCount: session.turnCount };
  });
  if (process.env.COCELL_E2E_KEEP_PROJECT !== '1') {
    await step('Clean up only this test project', async () => {
      await json(`/api/projects/${projectId}`, { method: 'DELETE', timeoutMs: operationTimeout });
      return { deletedProjectId: projectId };
    });
  } else report.keptProject = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = redact(error.message); process.exitCode = 1;
  console.error(`FAIL: ${report.error}`);
  if (projectId) console.error(`Preserved project ${projectId}${sessionId ? `; session ${sessionId}` : ''} for inspection.`);
} finally {
  report.finishedAt = new Date().toISOString(); await persist();
  console.log(`Result: ${report.status}; report: ${output}`);
}
