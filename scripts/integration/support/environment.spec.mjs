import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { LiveEnvironment, liveConfig } from './environment.mjs';

test('cleanup recovers a lost create response and never deletes an existing project', async ({}, testInfo) => {
  const projects = new Map([['existing', { id: 'existing', name: 'Existing user project' }]]);
  const deleted = [];
  const existingRole = '00000000-0000-4000-8000-000000000001', ownedRole = '00000000-0000-4000-8000-000000000002';
  const roles = new Map([[existingRole, { id: existingRole, name: 'Existing operator role' }]]);
  const deletedRoles = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tool-roles') { res.end(JSON.stringify({ roles: [...roles.values()], defaultRoleId: existingRole })); return; }
    if (req.url.startsWith('/api/tool-roles/') && req.method === 'DELETE') { const id = req.url.split('/').at(-1); deletedRoles.push(id); roles.delete(id); res.end('{"ok":true}'); return; }
    if (req.url === '/api/projects') { res.end(JSON.stringify([...projects.values()])); return; }
    if (req.url === '/api/archives') { res.end('[]'); return; }
    const id = req.url.split('/').at(-1);
    if (req.method === 'DELETE') { deleted.push(id); projects.delete(id); res.end('{"ok":true}'); return; }
    res.statusCode = projects.has(id) ? 200 : 404; res.end(JSON.stringify(projects.get(id) ?? { error: 'missing' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, COCELL_E2E_ACCESS_TOKEN: 'test-only-token' }), { journal: testInfo.outputPath('resources.json') });
  try {
    roles.set(ownedRole, { id: ownedRole, name: env.name('lost-role-create-response') });
    await expect(env.json('/api/tool-roles', { method: 'POST', body: { name: 'Operator role' } })).rejects.toThrow('current run prefix');
    await expect(env.json(`/api/tool-roles/${existingRole}`, { method: 'DELETE' })).rejects.toThrow('unowned role');
    await expect(env.json('/api/tool-roles/default', { method: 'PUT', body: { roleId: ownedRole } })).rejects.toThrow('unowned resource');
    projects.set('owned', { id: 'owned', name: env.name('accepted-but-response-lost') });
    await expect(env.json('/api/projects/existing', { method: 'DELETE' })).rejects.toThrow('unowned resource');
    await env.cleanup();
    expect(deleted).toEqual(['owned']); expect(projects.has('existing')).toBe(true);
    expect(deletedRoles).toEqual([ownedRole]); expect(roles.has(existingRole)).toBe(true);
    expect(JSON.parse(await readFile(env.journal, 'utf8')).cleanup).toEqual([{ projectId: 'owned', status: 'deleted_retained_backups', retainedSnapshots: [] }, { roleId: ownedRole, status: 'deleted' }]);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('cleanup DELETEs a test-owned project after a lost create response', async ({}, testInfo) => {
  const projects = new Map();
  const deleted = [];
  const boxes = new Set(['box-created']);
  let env;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tool-roles') { res.end('{"roles":[]}'); return; }
    if (req.method === 'POST' && req.url === '/api/projects') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      const project = { id: 'created', name: request.name, sandboxOperation: { status: 'running' },
        sandbox: { id: 'box-created', status: 'preparing' } };
      projects.set(project.id, project);
      res.statusCode = 201; res.end(JSON.stringify(project)); return;
    }
    if (req.url === '/api/projects') { res.end(JSON.stringify([...projects.values()])); return; }
    if (req.url === '/api/sandboxes') { res.end(JSON.stringify({ sandboxes: [...boxes].map(id => ({ id })) })); return; }
    if (req.url === '/api/archives') { res.end('[]'); return; }
    const id = req.url.split('/').at(-1);
    if (req.method === 'DELETE') { deleted.push(id); projects.delete(id); boxes.delete('box-created'); res.end('{"ok":true}'); return; }
    if (req.method === 'GET' && projects.has(id)) projects.get(id).sandboxOperation.status = 'succeeded';
    res.statusCode = projects.has(id) ? 200 : 404; res.end(JSON.stringify(projects.get(id) ?? { error: 'missing' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, COCELL_E2E_ACCESS_TOKEN: 'test-only-token' }),
    { journal: testInfo.outputPath('resources.json') });
  try {
    await expect(env.createProject('synchronous-create')).rejects.toThrow('completed sandbox operation');
    expect(env.projects.get('created')).toBe(env.name('synchronous-create'));
    expect(env.boxes.has('box-created')).toBe(true);
    await env.cleanup();
    expect(deleted).toEqual(['created']);
    expect(projects.has('created')).toBe(false);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('backup wait can include asynchronous disk archive completion', async ({}, testInfo) => {
  let reads = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tool-roles') { res.end('{"roles":[]}'); return; }
    reads++;
    res.end(JSON.stringify({ id: 'project', sandbox: { id: 'box', status: reads === 1 ? 'unavailable' : 'paused' },
      sandboxOperation: { id: 'backup', kind: 'backup', status: 'succeeded' },
      sandboxBackup: { id: 'backup', sandboxId: 'box', status: reads === 1 ? 'running' : 'succeeded', phase: '上传中', updatedAt: new Date().toISOString() },
      remoteArchives: reads === 1 ? [] : [{ id: 'archive' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, COCELL_E2E_ACCESS_TOKEN: 'test-only-token' }),
    { journal: testInfo.outputPath('resources.json') });
  try {
    const project = await env.waitProject('project', { kind: 'backup', status: 'paused', waitForBackup: true });
    expect(reads).toBe(2);
    expect(project.sandboxBackup.status).toBe('succeeded');
    expect(project.sandboxBackup.id).toBe(project.sandboxOperation.id);
    expect(project.sandboxBackup.sandboxId).toBe(project.sandbox.id);
    expect(project.remoteArchives[0].id).toBe('archive');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('cleanup DELETEs once, retains volume recovery metadata, and verifies resources are gone', async ({}, testInfo) => {
  let removed = false;
  let deleted = 0;
  let env;
  const project = { id: 'owned', name: '', status: 'active', sandbox: { id: 'box', status: 'ready' },
    sandboxMounts: [{ volumeId: 'volume-1', mountPath: '/workspace' }],
    sandboxOperation: { id: 'create', kind: 'create', status: 'succeeded' } };
  const retained = [{ key: 'volume-backup-key', storageType: 'cellbox-volume', volumeId: 'volume-1', snapshotId: 'a'.repeat(64) }];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tool-roles') { res.end('{"roles":[]}'); return; }
    if (req.url === '/api/projects' && req.method === 'GET') { res.end(JSON.stringify(removed ? [] : [project])); return; }
    if (req.url === '/api/sessions') { res.end('[]'); return; }
    if (req.url === '/api/sandboxes') { res.end('{"sandboxes":[]}'); return; }
    if (req.url === '/api/projects/owned' && req.method === 'GET') {
      if (removed) { res.statusCode = 404; res.end('{"error":"missing"}'); return; }
      res.end(JSON.stringify(project)); return;
    }
    if (req.url === '/api/projects/owned' && req.method === 'DELETE') { deleted++; removed = true; res.end('{"ok":true}'); return; }
    if (req.url === '/api/archives') { res.end(JSON.stringify([{ projectId: 'owned', archives: retained }])); return; }
    res.statusCode = 404; res.end('{"error":"missing"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, COCELL_E2E_ACCESS_TOKEN: 'test-only-token' }),
    { journal: testInfo.outputPath('resources.json') });
  project.name = env.name('direct-delete');
  env.projects.set('owned', project.name);
  try {
    await env.cleanup();
    expect(deleted).toBe(1);
    const cleanup = JSON.parse(await readFile(env.journal, 'utf8')).cleanup[0];
    expect(cleanup).toMatchObject({ projectId: 'owned', status: 'deleted_retained_backups',
      retainedSnapshots: [{ id: 'volume-backup-key', storageType: 'cellbox-volume', volumeId: 'volume-1', snapshotId: 'a'.repeat(64) }] });
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('cleanup leaves an unknown backup operation untouched instead of retrying or deleting it', async ({}, testInfo) => {
  let deleted = 0;
  let env;
  const project = { id: 'owned', name: '', status: 'active', sandbox: { id: 'box', status: 'paused' },
    sandboxOperation: { id: 'backup-op', kind: 'backup', status: 'unknown', error: 'response lost' },
    sandboxBackup: { id: 'backup-op', sandboxId: 'box', status: 'unknown', error: 'response lost' } };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tool-roles') { res.end('{"roles":[]}'); return; }
    if (req.url === '/api/projects' && req.method === 'GET') { res.end(JSON.stringify([project])); return; }
    if (req.url === '/api/sessions') { res.end('[]'); return; }
    if (req.url === '/api/sandboxes') { res.end('{"sandboxes":[{"id":"box"}]}'); return; }
    if (req.url === '/api/projects/owned' && req.method === 'GET') { res.end(JSON.stringify(project)); return; }
    if (req.url === '/api/projects/owned' && req.method === 'DELETE') { deleted++; res.end('{"ok":true}'); return; }
    res.statusCode = 404; res.end('{"error":"missing"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, COCELL_E2E_ACCESS_TOKEN: 'test-only-token' }),
    { journal: testInfo.outputPath('resources.json') });
  project.name = env.name('unknown-backup');
  env.projects.set('owned', project.name);
  try {
    await expect(env.cleanup()).rejects.toThrow('Integration cleanup failed');
    expect(deleted).toBe(0);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('cleanup leaves an unknown prior sandbox operation untouched instead of deleting it', async ({}, testInfo) => {
  let deleted = 0;
  let env;
  const project = { id: 'owned', name: '', status: 'active', sandbox: { id: 'box', status: 'ready' },
    sandboxOperation: { id: 'checkpoint-op', kind: 'checkpoint', status: 'unknown', error: 'response lost' } };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tool-roles') { res.end('{"roles":[]}'); return; }
    if (req.url === '/api/projects' && req.method === 'GET') { res.end(JSON.stringify([project])); return; }
    if (req.url === '/api/sessions') { res.end('[]'); return; }
    if (req.url === '/api/sandboxes') { res.end('{"sandboxes":[{"id":"box"}]}'); return; }
    if (req.url === '/api/projects/owned' && req.method === 'GET') { res.end(JSON.stringify(project)); return; }
    if (req.url === '/api/projects/owned' && req.method === 'DELETE') { deleted++; res.end('{"ok":true}'); return; }
    res.statusCode = 404; res.end('{"error":"missing"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, COCELL_E2E_ACCESS_TOKEN: 'test-only-token' }),
    { journal: testInfo.outputPath('resources.json') });
  project.name = env.name('unknown-checkpoint');
  env.projects.set('owned', project.name);
  try {
    await expect(env.cleanup()).rejects.toThrow('Integration cleanup failed');
    expect(deleted).toBe(0);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('cleanup failures fail the suite and redact the operator token in evidence', async ({}, testInfo) => {
  const token = 'secret-that-must-never-appear';
  let env;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tool-roles') { res.end('{"roles":[]}'); return; }
    const project = { id: 'owned', name: env.name('failure') };
    if (req.url === '/api/projects') { res.end(JSON.stringify([project])); return; }
    if (req.method === 'DELETE') { res.statusCode = 503; res.end(JSON.stringify({ error: token })); return; }
    res.end(JSON.stringify(project));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, COCELL_E2E_ACCESS_TOKEN: token }), { journal: testInfo.outputPath('resources.json') });
  try {
    await expect(env.cleanup()).rejects.toThrow('Integration cleanup failed');
    const evidence = await readFile(env.journal, 'utf8');
    expect(evidence).not.toContain(token); expect(evidence).toContain('[redacted]');
    expect(JSON.parse(evidence).cleanup[0].status).toBe('failed');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('failure evidence keeps task and command details with a redacted original stack', async ({}, testInfo) => {
  const token = 'private-diagnostic-token';
  const env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: 'http://127.0.0.1:3001', COCELL_E2E_ACCESS_TOKEN: token }),
    { journal: testInfo.outputPath('resources.json') });
  env.sessions.add('owned');
  env.json = async () => ({ id: 'owned', status: 'completed', threadId: 'native', turns: [{ id: 'turn',
    prompt: `Read the file ${token}`, status: 'completed', items: [
      { type: 'command_execution', command: `node read.js ${token}`, aggregated_output: `content ${token}`, exit_code: 0, status: 'completed' },
      { type: 'agent_message', text: `reply ${token}` },
    ] }] });
  await env.captureFailure();
  const original = new Error(`failed ${token}`);
  original.stack = `Error: failed ${token}\n    at originalAssertion (/fixture/check.mjs:28:5)`;
  let caught;
  try { await env.step('read shared file', async () => { throw original; }); } catch (error) { caught = error; }
  expect(caught.stack).toContain('/fixture/check.mjs:28:5');
  expect(caught.stack).not.toContain(token);
  const raw = await readFile(env.journal, 'utf8');
  expect(raw).not.toContain(token);
  const turn = JSON.parse(raw).failedSessions[0].turns[0];
  expect(turn.prompt).toBe('Read the file [redacted]');
  expect(turn.items[0]).toMatchObject({ command: 'node read.js [redacted]', aggregated_output: 'content [redacted]', exit_code: 0 });
  expect(turn.items[1].text).toBe('reply [redacted]');
});
