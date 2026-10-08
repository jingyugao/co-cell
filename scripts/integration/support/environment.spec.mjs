import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { LiveEnvironment, liveConfig } from './environment.mjs';

test('cleanup recovers a lost create response and never deletes an existing project', async ({}, testInfo) => {
  const projects = new Map([['existing', { id: 'existing', name: 'Existing user project' }]]);
  const deleted = [];
  const server = createServer((req, res) => {
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
