import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { test } from '../support/fixtures.mjs';
import { createConversation, runAgent } from '../support/agent.mjs';

test('real Sandbox connects directly to its model channel and keeps conversation history', async ({ environment: env }) => {
  const context = process.env.COCELL_E2E_KUBE_CONTEXT;
  assert(context, 'Direct channel verification requires an explicit Kubernetes context');
  const namespace = process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box';
  const kube = async args => (await promisify(execFile)('kubectl', ['--context', context, '-n', namespace, ...args],
    { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout;
  const project = await env.createProject('direct-channel');
  const ready = await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  const session = await createConversation(env, project, 'Direct model channel verification');
  const marker = randomUUID();
  const first = await env.step('Complete a real model turn through the selected channel', async () => {
    const result = await runAgent(env, session, `Remember this verification marker in our conversation: ${marker}. Reply with exactly the marker. Do not use tools, subagents, or write files.`);
    assert(result.text.includes(marker));
    return { threadId: result.session.threadId };
  });
  await env.step('Inspect native provider metadata without reading credentials', async () => {
    const boxes = JSON.parse(await kube(['get', 'cellboxes', '-l', `cellbox.local/box-id=${ready.sandbox.id}`, '-o', 'json']));
    assert.equal(boxes.items.length, 1);
    const box = boxes.items[0];
    const pod = JSON.parse(await kube(['get', 'pod', box.status.podName, '-o', 'json']));
    assert.equal(pod.metadata.uid, box.status.podUID);
    assert(pod.metadata.ownerReferences.some(ref => ref.controller && ref.uid === box.metadata.uid));
    const code = `const fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(`${ready.workingDirectory}/.cocell/codex/sessions`)};const id=${JSON.stringify(first.threadId)};const files=fs.readdirSync(root,{recursive:true}).filter(f=>f.endsWith('.jsonl')&&f.includes(id));if(files.length!==1)throw Error('Expected one native thread file');const header=JSON.parse(fs.readFileSync(path.join(root,files[0]),'utf8').split('\\n')[0]);console.log(JSON.stringify({threadId:header.payload.id,provider:header.payload.model_provider}));`;
    const metadata = JSON.parse(await kube(['exec', pod.metadata.name, '--', '/usr/local/bin/node', '-e', code]));
    assert.equal(metadata.threadId, first.threadId);
    assert.match(metadata.provider, /^cocell_direct_[a-f0-9]{64}$/);
    await env.request(`/api/model-runtime/${session.id}/v1/models`, { expectedStatus: 404 });
    return metadata;
  });
  await env.step('A subsequent turn retains the native thread and recalls its history', async () => {
    const result = await runAgent(env, session, 'Reply with exactly the verification marker from my previous message. Do not use tools, subagents, or read files.');
    assert.equal(result.session.threadId, first.threadId);
    assert(result.text.includes(marker));
    return { threadId: result.session.threadId, recalledMarker: true };
  });
});
