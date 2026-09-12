import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { installSandboxesRoutes } from './routes.js';

test('DELETE /api/sandboxes/:id delegates guarded dangling sandbox deletion', async () => {
  const calls: string[] = [];
  const app = new Hono();
  installSandboxesRoutes(app, { async read() { return { enabled: true, fetchedAt: '', sandboxes: [] }; } }, {
    list: () => [],
    listProjects: () => [],
    async deleteDanglingSandbox(id: string) { calls.push(id); },
  } as never);

  const response = await app.request('/api/sandboxes/sandbox-123', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(calls, ['sandbox-123']);
});
