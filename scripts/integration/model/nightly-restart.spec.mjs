import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from '../support/fixtures.mjs';
import { createConversation, fileURL, finish, runAgent, submit, waitCommandStart } from '../support/agent.mjs';
import { liveTransport } from '../support/kubernetes.mjs';

test('nightly: Web restart recovers an active native turn without executing its command twice', async ({ environment: env }) => {
  test.skip(process.env.GITHUB_ACTIONS !== 'true' || process.env.COCELL_E2E_DISPOSABLE_CI !== '1', 'Only restart the dedicated disposable GitHub installation');
  const context = process.env.COCELL_E2E_KUBE_CONTEXT, namespace = process.env.COCELL_E2E_NAMESPACE;
  assert.equal(context, 'cocell-ci'); assert.equal(namespace, 'co-cell-ci');
  const kube = args => execFileSync('kubectl', ['--context', context, '-n', namespace, ...args], { encoding: 'utf8', timeout: 180_000 });
  const nodes = JSON.parse(kube(['get', 'nodes', '-o', 'json'])).items;
  assert(nodes.length === 1 && nodes[0].metadata.labels['cocell-ci-run'] === process.env.GITHUB_RUN_ID, 'Refusing to restart an unrelated installation');
  const project = await env.createProject('web-restart');
  const ready = await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  const session = await createConversation(env, project, 'Web restart recovery');
  const marker = randomUUID(), folder = `restart-${marker}`;
  const { turnId } = await submit(env, session, `Only write under ${folder}/. Do not use subagents, credentials or external systems. Run one foreground Node command that creates this directory, reads count.txt (0 if absent), increments it and saves the count, prints started-${marker}, then waits 60 seconds and writes done.txt containing ${marker}. Use exec_command yield_time_ms=1000 and poll that same command until completion; reply ${marker}. Do not detach the command or execute it again.`);
  await waitCommandStart(env, session, `started-${marker}`);
  const before = await env.json(`/api/sessions/${session.id}`);
  assert.equal(before.turns.find(turn => turn.id === turnId || turn.nativeTurnId === turnId)?.status, 'running');
  assert(before.threadId);
  await env.step('Restart only the disposable CoCell deployment and reconnect its API transport', async () => {
    kube(['rollout', 'restart', 'deployment/co-cell']);
    kube(['rollout', 'status', 'deployment/co-cell', '--timeout=150s']);
    const transport = await liveTransport({ ...process.env, COCELL_E2E_BASE_URL: undefined, COCELL_E2E_SERVICE: 'co-cell' });
    env.transports.push(transport);
    env.config.base = new URL(transport.env.COCELL_E2E_BASE_URL);
    return { deployment: 'co-cell', namespace };
  });
  await env.step('Recovered native turn finishes once and keeps files and history', async () => {
    const recovered = await finish(env, session, turnId);
    assert.equal(recovered.session.threadId, before.threadId);
    assert.equal(recovered.session.turns.filter(turn => turn.prompt.includes(folder)).length, 1);
    assert.equal((await env.json(fileURL(ready, `${folder}/count.txt`))).trim(), '1');
    assert.equal((await env.json(fileURL(ready, `${folder}/done.txt`))).trim(), marker);
    assert(recovered.text.includes(marker));
    const next = await runAgent(env, session, `Read ${folder}/done.txt using Node and reply its exact content. Do not run the previous command again.`);
    assert.equal(next.session.threadId, before.threadId);
    assert(next.text.includes(marker));
    return { threadId: before.threadId, count: 1 };
  });
});
