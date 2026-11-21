import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from '../support/fixtures.mjs';

test('real agent creates files and starts a persistent HTTP service', async ({ environment: env }) => {
  const project = await env.createProject('agent-http');
  const ready = await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  const session = await env.json('/api/sessions', { method: 'POST', expectedStatus: 201, body: {
    projectId: project.id, title: 'Real agent HTTP smoke',
    settings: { model: env.config.model, modelReasoningEffort: 'low', webSearchMode: 'disabled' },
  } });
  const marker = randomUUID(), first = randomUUID(), second = randomUUID(), port = 18080;
  const folder = 'ci-agent-http';
  let threadId;
  async function turn(prompt) {
    const { turnId } = await env.json(`/api/sessions/${session.id}/turns`, { method: 'POST', expectedStatus: 202, body: { prompt, images: [] } });
    const deadline = Date.now() + env.config.turnTimeout;
    while (Date.now() < deadline) {
      const current = await env.json(`/api/sessions/${session.id}`);
      const result = current.turns.find(turn => turn.id === turnId);
      if (result && result.status !== 'running') {
        assert.equal(result.status, 'completed', env.redact(result.error ?? 'Agent turn failed'));
        assert(result.items.some(item => item.type === 'command_execution'), 'Agent did not execute a command');
        assert(current.threadId, 'Missing native conversation thread');
        if (threadId) assert.equal(current.threadId, threadId, 'Conversation thread changed');
        threadId = current.threadId;
        await env.waitIdle(project.id);
        return { turnId, threadId, commands: result.items.filter(item => item.type === 'command_execution').length };
      }
      await delay(1000, undefined, { signal: env.controller.signal });
    }
    await env.json(`/api/sessions/${session.id}/stop`, { method: 'POST', body: {} });
    throw new Error('Agent turn timed out');
  }
  async function verify(expected) {
    const challenge = randomUUID();
    const response = await env.json(`/api/projects/${project.id}/service/${port}/healthz?challenge=${challenge}`);
    assert.equal(response.marker, marker);
    assert.equal(response.content, expected);
    assert.equal(response.challenge, challenge);
    assert(Number.isSafeInteger(response.pid) && response.pid > 0);
    assert(typeof response.instance === 'string' && response.instance.length >= 16);
    const file = await env.json(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(`${ready.workingDirectory}/${folder}/content.txt`)}`);
    assert.equal(file.trim(), expected);
    return response;
  }
  await env.step('Agent creates and starts its real service', () => turn(`This is a real integration test. Execute the task; do not merely provide code. Use only preinstalled Node.js standard libraries. Do not install software, use subagents, read credentials, or access external business systems. Only write inside ${folder}/ in the project workspace.
Create content.txt containing ${first} plus newline. Create a Node HTTP service bound to 127.0.0.1:${port}. GET /healthz must return JSON with marker=${marker}, content read freshly from content.txt and trimmed, challenge echoed from its query parameter, pid=process.pid, and instance=crypto.randomUUID() generated once at process startup. Return 404 for other paths.
Start it using a detached child process with stdin ignored, stdout/stderr appended to server.log, and child.unref(), so it survives the end of this conversation turn. Use absolute paths and the correct cwd. Check the script syntax and make a real HTTP request. Leave the process running.`));
  const initial = await env.step('Verify real files and proxied HTTP independently', () => verify(first));
  await env.step('Continue the same conversation and edit the served file', () => turn(`Keep the existing server running. Change ${folder}/content.txt to ${second} plus newline. Do not restart or replace the process. Make an HTTP request to verify that it serves the changed content.`));
  await delay(10_000, undefined, { signal: env.controller.signal });
  await env.step('Verify process continuity and changed content after ten seconds', async () => {
    const current = await verify(second);
    assert.equal(current.pid, initial.pid);
    assert.equal(current.instance, initial.instance);
    return current;
  });
});

test('real workflow gates parallel file owners and records independent validation', async ({
  environment: env,
}) => {
  const config = await env.json('/api/config');
  assert(
    config.capabilities.workflows,
    'This test requires a test installation built with the workflow workbench'
  );
  const project = await env.createProject('workflow-files');
  await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  const base = '/api/workflow-runs';
  const input = {
    projectId: project.id,
    parallelism: 3,
    clientRequestId: randomUUID(),
    requirement:
      'Create alpha.txt containing alpha and beta.txt containing beta, one line each. Use two independent worker tasks, one per file. Integration and final verification check both files. Use node -e assertions as each validation argv. Work only on these files. Keep design and reviews concise.',
  };
  const send = (path, body) => env.json(path, { method: 'POST', expectedStatus: 202, body });
  const { id } = await send(base, input);
  let approved = false,
    parallel = false;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const r = await env.json(base + '/' + id);
    if (!approved) assert(!r.jobs.some((j) => j.spec && j.attempts.length), 'Writable task before approval');
    if (r.status === 'awaiting_human') {
      await send(base + '/' + id + '/resume', {
        expectedRevision: r.revision,
        clientRequestId: randomUUID(),
        reason: 'Keep both file changes independent. Use the requested node assertions.',
      });
    } else if (r.status === 'awaiting_approval') {
      const p = r.plans.at(-1);
      assert.equal(p.plan.tasks.filter((t) => t.role === 'worker').length, 2);
      for (const task of p.plan.tasks) {
        assert(task.ownedPaths.every((path) => ['alpha.txt', 'beta.txt'].includes(path)));
        assert.deepEqual(task.validation.argv.slice(0, 2), ['node', '-e']);
      }
      const decision = {
        clientRequestId: randomUUID(),
        expectedRevision: r.revision,
        planId: p.id,
        planHash: p.hash,
        approvalRevision: p.approvalRevision,
        decision: 'approve',
        reason: 'Approve the isolated two-file test',
      };
      const endpoint = base + '/' + id + '/approvals/' + p.approvalId + '/decisions';
      assert.deepEqual(await send(endpoint, decision), await send(endpoint, decision));
      approved = true;
    } else if (r.status === 'blocked' || r.status === 'cancelled') assert.fail(r.attention ?? r.status);
    parallel ||= r.jobs.filter((j) => j.role === 'worker' && j.attempts.at(-1)?.status === 'running').length >= 2;
    if (r.status === 'completed') {
      assert(approved && parallel, 'Expected approved, overlapping native attempts');
      const workers = r.jobs.filter((j) => j.role === 'worker').map((j) => j.attempts.at(-1));
      assert(
        Math.min(...workers.map((a) => Date.parse(a.nativeCompletedAt))) >
          Math.max(...workers.map((a) => Date.parse(a.nativeStartedAt))),
        'Native worker turn intervals must overlap'
      );
      for (const j of r.jobs.filter((j) => j.spec)) {
        assert.equal(j.attempts.length, 1);
        const attempt = j.attempts[0];
        assert(attempt.turnId && attempt.threadId && attempt.validation.operationId);
        assert.equal(attempt.validation.exitCode, 0);
      }
      return;
    }
    await delay(1000, undefined, { signal: env.controller.signal });
  }
  assert.fail('Workflow exceeded the test deadline');
});
