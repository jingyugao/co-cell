import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { SessionManager } from '../server/manager.js';
import { TemplateManager } from '../server/templates.js';
import type { AppConfig } from '../shared/types.js';

test('template routes enforce local origin, validate drafts and propagate revision conflicts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'template-api-'));
  const config: AppConfig = {
    defaults: { workingDirectory: directory, model: '', modelReasoningEffort: 'low', sandboxMode: 'read-only', webSearchMode: 'disabled', networkAccessEnabled: false },
    sdkVersion: 'test', auth: 'local-codex', approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false },
  };
  const manager = new SessionManager({ startThread() { throw Error('Unused'); }, resumeThread() { throw Error('Unused'); } }, join(directory, 'sessions'), config.defaults);
  const templates = new TemplateManager({ directory: join(directory, 'templates'), legacyDirectory: directory, initialDefault: 'base', enabled: false });
  await manager.init(); await templates.init();
  t.after(async () => { await templates.close(); await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const app = createApp(manager, config, ['localhost:3001'], undefined, undefined, undefined, templates);
  const request = (path: string, method = 'GET', body?: unknown, origin?: string) => app.request(`http://localhost:3001${path}`, {
    method, headers: { host: 'localhost:3001', 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal((await request('/api/templates', 'GET', undefined, 'https://foreign.example')).status, 403);
  const inventory = await (await request('/api/templates')).json();
  const manifest = inventory.templates[0].manifest;
  assert.equal((await request('/api/templates', 'POST', { name: 'bad', manifest: { ...manifest, systemPackages: ['--option'] } })).status, 400);
  const created = await request('/api/templates', 'POST', { name: 'API fixture', manifest });
  assert.equal(created.status, 201);
  const draft = await created.json();
  const path = `/api/templates/${draft.id}`;
  assert.equal((await request(path, 'PUT', { name: 'renamed', manifest, version: draft.version })).status, 200);
  assert.equal((await request(path, 'DELETE', { version: draft.version })).status, 409);
  const current = (await templates.list()).templates.find(item => item.id === draft.id)!;
  assert.equal((await request(`${path}/builds`, 'POST', { version: current.version })).status, 400);
  assert.equal((await request(path, 'DELETE', { version: current.version })).status, 200);
  assert.equal((await request('/api/template-builds/missing/activate', 'POST')).status, 404);
});
