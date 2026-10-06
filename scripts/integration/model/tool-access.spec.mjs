import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from '../support/fixtures.mjs';

test('prepared image tools use project credentials in a real conversation', async ({ environment: env }) => {
  test.skip(!process.env.COCELL_E2E_TOOL_IMAGE_ID, 'Requires an operator-approved tool image and explicit read-only tool cases');
  const imageId = process.env.COCELL_E2E_TOOL_IMAGE_ID;
  const imageVersionId = process.env.COCELL_E2E_TOOL_IMAGE_VERSION_ID;
  const cases = JSON.parse(process.env.COCELL_E2E_TOOL_CASES ?? '[]');
  const selections = JSON.parse(process.env.COCELL_E2E_TOOL_SELECTIONS ?? '[]');
  assert(imageVersionId && cases.length && selections.length, 'Tool image, cases and credential selections are required');
  const project = await env.json('/api/projects', { method: 'POST', expectedStatus: 201,
    body: { name: env.name('prepared-tool-access'), type: 1, imageId, imageVersionId } });
  env.report.projectId = project.id;
  await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  await env.json(`/api/projects/${project.id}/tool-grants`, { method: 'PUT', body: { selections } });
  await env.json(`/api/projects/${project.id}/sandbox/refresh-runtime`, { method: 'POST', expectedStatus: 202 });
  await env.waitProject(project.id, { status: 'ready' });
  const session = await env.json('/api/sessions', { method: 'POST', expectedStatus: 201,
    body: { projectId: project.id, title: 'Prepared image tool verification', settings: { model: env.config.model, modelReasoningEffort: 'low', webSearchMode: 'disabled' } } });
  env.report.sessionId = session.id;
  const marker = `tool-check-${randomUUID()}`;
  const script = `const {spawnSync}=require('node:child_process');const cases=${JSON.stringify(cases)};let failed=false;for(const c of cases){const r=spawnSync(c.tool,c.args,{encoding:'utf8',timeout:25000});const ok=r.status===0&&(!c.expect||r.stdout.includes(c.expect));console.log(JSON.stringify({marker:${JSON.stringify(marker)},tool:c.tool,ok,exitCode:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr}));if(!ok)failed=true;}process.exitCode=failed?1:0;`;
  const command = 'node -e ' + "'" + script.replaceAll("'", "'\\''") + "'";
  const prompt = `这是工具接入回归测试。请原样执行以下命令，只执行这一条命令，不使用子 agent，不读取或输出凭据文件，不修改集群和数据库。完成后简短汇报。\n${command}`;
  const { turnId } = await env.json(`/api/sessions/${session.id}/turns`, { method: 'POST', expectedStatus: 202, body: { prompt } });
  const deadline = Date.now() + env.config.turnTimeout;
  while (Date.now() < deadline) {
    const snapshot = await env.json(`/api/sessions/${session.id}`);
    const turn = snapshot.turns.find(t => t.id === turnId || t.prompt === prompt);
    if (turn && turn.status !== 'running') {
      assert.equal(turn.status, 'completed', turn.error);
      const commands = turn.items.filter(i => i.type === 'command_execution');
      const results = commands.flatMap(i => (i.aggregated_output ?? '').split('\n').flatMap(line => {
        try { const value = JSON.parse(line); return value.marker === marker ? [value] : []; } catch { return []; }
      }));
      env.report.toolResults = results;
      await env.persist();
      assert.equal(results.length, cases.length, 'Every result must come from real command output');
      assert.deepEqual(results.map(r => ({ tool: r.tool, ok: r.ok })), cases.map(c => ({ tool: c.tool, ok: true })));
      return;
    }
    await delay(2000, undefined, { signal: env.controller.signal });
  }
  throw new Error('Tool conversation timed out');
});
