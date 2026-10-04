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
