import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { LiveEnvironment, liveConfig } from './environment.mjs';

test('cleanup recovers a lost create response and never deletes an existing project', async ({}, testInfo) => {
  const projects = new Map([['existing', { id: 'existing', name: 'Existing user project' }]]);
  const deleted = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/projects') { res.end(JSON.stringify([...projects.values()])); return; }
    const id = req.url.split('/').at(-1);
    if (req.method === 'DELETE') { deleted.push(id); projects.delete(id); res.end('{"ok":true}'); return; }
    res.statusCode = projects.has(id) ? 200 : 404; res.end(JSON.stringify(projects.get(id) ?? { error: 'missing' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, COCELL_E2E_ACCESS_TOKEN: 'test-only-token' }), { journal: testInfo.outputPath('resources.json') });
  try {
    projects.set('owned', { id: 'owned', name: env.name('accepted-but-response-lost') });
    await expect(env.json('/api/projects/existing', { method: 'DELETE' })).rejects.toThrow('unowned resource');
    await env.cleanup();
    expect(deleted).toEqual(['owned']); expect(projects.has('existing')).toBe(true);
    expect(JSON.parse(await readFile(env.journal, 'utf8')).cleanup).toEqual([{ projectId: 'owned', status: 'deleted' }]);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('cleanup preserves a preparing sandbox after a synchronous create failure', async ({}, testInfo) => {
  const projects = new Map();
  const deleted = [];
  let env;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
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
    if (req.url === '/api/sandboxes') { res.end('{"sandboxes":[{"id":"box-created"}]}'); return; }
    const id = req.url.split('/').at(-1);
    if (req.method === 'DELETE') { deleted.push(id); projects.delete(id); res.end('{"ok":true}'); return; }
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
    await expect(env.cleanup()).rejects.toThrow('Integration cleanup failed');
    expect(deleted).toEqual([]);
    expect(projects.has('created')).toBe(true);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('backup wait can include asynchronous disk archive completion', async ({}, testInfo) => {
  let reads = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
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

test('cleanup checkpoints once, backs up once, archives the backup, then deletes once', async ({}, testInfo) => {
  let reads = 0;
  let checkpointCalls = 0;
  let backupCalls = 0;
  let archiveCalls = 0;
  let deleted = 0;
  let removed = false;
  let archived = false;
  const calls = [];
  let env;
  const project = () => ({ id: 'owned', name: env.name('async-checkpoint'), status: archived ? 'archived' : 'active',
    ...(archived ? {} : { sandbox: { id: 'box', status: checkpointCalls ? 'paused' : 'ready' } }),
    sandboxOperation: archived
      ? { id: 'archive-op', kind: 'archive', status: 'succeeded' }
      : backupCalls ? { id: 'backup-op', kind: 'backup', status: 'succeeded' }
        : checkpointCalls ? { id: 'checkpoint-op', kind: 'checkpoint', status: 'succeeded' }
          : { id: 'create', kind: 'create', status: 'succeeded' },
    ...(backupCalls ? { sandboxBackup: { id: 'backup-op', sandboxId: 'box', status: 'succeeded' },
      remoteArchives: [{ id: 'archive', sourceSandboxId: 'box' }] } : {}) });
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/projects' && req.method === 'GET') { res.end(JSON.stringify(removed ? [] : [project()])); return; }
    if (req.url === '/api/sessions') { res.end('[]'); return; }
    if (req.url === '/api/sandboxes') { res.end('{"sandboxes":[]}'); return; }
    if (req.url === '/api/projects/owned' && req.method === 'GET') {
      if (removed) { res.statusCode = 404; res.end('{"error":"missing"}'); return; }
      reads++;
      res.end(JSON.stringify(project())); return;
    }
    if (req.url === '/api/projects/owned/sandbox/checkpoint' && req.method === 'POST') {
      checkpointCalls++;
      expect(checkpointCalls).toBe(1);
      calls.push('checkpoint');
      res.end(JSON.stringify({ ...project(), sandboxOperation: { id: 'checkpoint-op', kind: 'checkpoint', status: 'succeeded' } })); return;
    }
    if (req.url === '/api/projects/owned/backup' && req.method === 'POST') {
      backupCalls++;
      expect(checkpointCalls).toBe(1);
      expect(backupCalls).toBe(1);
      calls.push('backup');
      const state = project();
      expect(state.sandboxOperation).toMatchObject({ id: state.sandboxBackup.id, kind: 'backup', status: 'succeeded' });
      expect(state.sandboxBackup.sandboxId).toBe(state.sandbox.id);
      res.end(JSON.stringify(state)); return;
    }
    if (req.url === '/api/projects/owned/archive' && req.method === 'POST') {
      archiveCalls++;
      expect(archiveCalls).toBe(1);
      expect(backupCalls).toBe(1);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const reqBody = Buffer.concat(chunks).toString();
      expect(JSON.parse(reqBody)).toEqual({ useExistingBackup: true });
      calls.push('archive');
      archived = true;
      res.end(JSON.stringify(project())); return;
    }
    if (req.url === '/api/projects/owned' && req.method === 'DELETE') {
      expect(checkpointCalls).toBe(1);
      expect(backupCalls).toBe(1);
      expect(archiveCalls).toBe(1);
      deleted++;
      calls.push('delete');
      removed = true;
      res.end('{"ok":true}'); return;
    }
    if (req.url === '/api/projects/owned' && req.method === 'HEAD') { res.statusCode = 404; res.end(); return; }
    if (req.url === '/api/projects/owned') { res.statusCode = 404; res.end('{"error":"missing"}'); return; }
    res.statusCode = 404; res.end('{"error":"missing"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env = new LiveEnvironment(liveConfig({ COCELL_E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, COCELL_E2E_ACCESS_TOKEN: 'test-only-token' }),
    { journal: testInfo.outputPath('resources.json') });
  env.projects.set('owned', env.name('async-checkpoint'));
  try {
    await env.cleanup();
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(checkpointCalls).toBe(1);
    expect(backupCalls).toBe(1);
    expect(archiveCalls).toBe(1);
    expect(deleted).toBe(1);
    expect(calls).toEqual(['checkpoint', 'backup', 'archive', 'delete']);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('cleanup does not replay an unknown backup or archive/delete its sandbox', async ({}, testInfo) => {
  let checkpointCalls = 0;
  let backupCalls = 0;
  let archiveCalls = 0;
  let deleted = 0;
  let env;
  const project = { id: 'owned', name: '', status: 'active', sandbox: { id: 'box', status: 'ready' },
    sandboxOperation: { id: 'create', kind: 'create', status: 'succeeded' } };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/projects' && req.method === 'GET') { res.end(JSON.stringify([project])); return; }
    if (req.url === '/api/sessions') { res.end('[]'); return; }
    if (req.url === '/api/sandboxes') { res.end('{"sandboxes":[{"id":"box"}]}'); return; }
    if (req.url === '/api/projects/owned' && req.method === 'GET') { res.end(JSON.stringify(project)); return; }
    if (req.url === '/api/projects/owned/sandbox/checkpoint' && req.method === 'POST') {
      checkpointCalls++;
      project.sandbox.status = 'paused';
      project.sandboxOperation = { id: 'checkpoint-op', kind: 'checkpoint', status: 'succeeded' };
      res.end(JSON.stringify(project)); return;
    }
    if (req.url === '/api/projects/owned/backup' && req.method === 'POST') {
      backupCalls++;
      project.sandboxOperation = { id: 'backup-op', kind: 'backup', status: 'unknown', error: 'response lost' };
      project.sandboxBackup = { id: 'backup-op', sandboxId: 'box', status: 'unknown', error: 'response lost' };
      res.end(JSON.stringify(project)); return;
    }
    if (req.url === '/api/projects/owned/archive' && req.method === 'POST') { archiveCalls++; assert.fail('Unknown backup must not be followed by archive'); }
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
    expect(checkpointCalls).toBe(1);
    expect(backupCalls).toBe(1);
    expect(archiveCalls).toBe(0);
    expect(deleted).toBe(0);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('cleanup does not replay an unknown checkpoint or delete its sandbox', async ({}, testInfo) => {
  let checkpointCalls = 0;
  let deleted = 0;
  let env;
  const project = { id: 'owned', name: '', status: 'active', sandbox: { id: 'box', status: 'ready' },
    sandboxOperation: { id: 'create', kind: 'create', status: 'succeeded' } };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/projects' && req.method === 'GET') { res.end(JSON.stringify([project])); return; }
    if (req.url === '/api/sessions') { res.end('[]'); return; }
    if (req.url === '/api/sandboxes') { res.end('{"sandboxes":[{"id":"box"}]}'); return; }
    if (req.url === '/api/projects/owned' && req.method === 'GET') { res.end(JSON.stringify(project)); return; }
    if (req.url === '/api/projects/owned/sandbox/checkpoint' && req.method === 'POST') {
      checkpointCalls++;
      project.sandboxOperation = { id: 'checkpoint-unknown', kind: 'checkpoint', status: 'unknown', error: 'response lost' };
      res.end(JSON.stringify(project)); return;
    }
    if (req.url === '/api/projects/owned/archive' && req.method === 'POST') assert.fail('Unknown checkpoint must not be followed by archive');
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
    expect(checkpointCalls).toBe(1);
    expect(deleted).toBe(0);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('cleanup failures fail the suite and redact the operator token in evidence', async ({}, testInfo) => {
  const token = 'secret-that-must-never-appear';
  let env;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
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
