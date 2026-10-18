import assert from 'node:assert/strict';
import test from 'node:test';
import { CellboxClient, CellboxError } from './client.js';
import { CellboxSandboxProvider } from './provider.js';

const caps = { exec: true, files: true, http: true, websocket: true, pty: false, reconnectExec: false,
  freeze: false, suspend: 'same-node-checkpoint' as const, archives: 'workspace-best-effort', protectedTools: false };
const profile = { id: 'profile-a', provider: 'resumable-k8s-pod', capabilities: caps, runtime: 'k8s',
  behavior: 'resumable', kind: 'k8s-resumable', image: 'legacy-profile-image', workspace: '/workspace',
  agent: { uid: 1000, gid: 1000 }, cpu: 2, memoryMiB: 4096 };
const box = (phase: 'running' | 'suspended' | 'resuming', extra: Record<string, unknown> = {}) => ({
  id: 'box-a', ownerKey: 'project:p1', profileId: 'profile-a', phase, generation: 4, resourceVersion: 4,
  image: 'sha256:box-image', imageId: 'rev-a', workspace: '/workspace', capabilities: caps,
  createdAt: new Date().toISOString(), ...extra,
});
const op = (kind: string, status: 'succeeded' | 'running' = 'succeeded') => ({ id: 'op-a', kind,
  targetId: 'box-a', status, version: 2, createdAt: new Date().toISOString() });

function provider(fetch: typeof globalThis.fetch, options: { templateId?: string; revisionId?: string } = {}) {
  return new CellboxSandboxProvider({ baseUrl: 'http://cellbox.test', profileId: 'profile-a', ...options, fetch });
}

test('a lost create response is reported unknown and submitted once without an idempotency header', async () => {
  let submissions = 0;
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async (_input, init) => {
    submissions++;
    assert.equal(new Headers(init?.headers).has('Idempotency-Key'), false);
    throw new Error('connection dropped after submission');
  } });
  await assert.rejects(client.createBox({ ownerKey: 'project:p1', revisionId: 'rev-a' }, 'legacy-key'),
    error => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME' && /unknown/.test(error.message));
  assert.equal(submissions, 1);
});

test('template and revision API methods use the current routes and request shapes', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname + new URL(String(input)).search, body });
    return Response.json({ id: 'tpl-a' });
  } });
  await client.createTemplate({ name: 'agent' });
  await client.createTemplateRevision('tpl-a', { userVersion: '1.0', baseImage: 'alpine:3', profileId: 'profile-a' });
  await client.getTemplateRevision('rev-a');
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/templates', body: { name: 'agent' } },
    { method: 'POST', path: '/v1/templates/tpl-a/revisions', body: { userVersion: '1.0', baseImage: 'alpine:3', profileId: 'profile-a' } },
    { method: 'GET', path: '/v1/template-revisions/rev-a', body: undefined },
  ]);
});

test('provider requires one default selector and metadata can override the configured default', async () => {
  assert.throws(() => new CellboxSandboxProvider({ baseUrl: 'http://cellbox.test', profileId: 'profile-a',
    fetch: async () => Response.json([]) }), /Exactly one/);
  assert.throws(() => new CellboxSandboxProvider({ baseUrl: 'http://cellbox.test', profileId: 'profile-a',
    templateId: 'tpl-a', revisionId: 'rev-a', fetch: async () => Response.json([]) }), /Exactly one/);

  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ path, body });
    if (path === '/v1/profiles') return Response.json([profile]);
    if (path === '/v1/boxes') return Response.json(op('create'));
    if (path === '/v1/operations/op-a') return Response.json(op('create'));
    if (path === '/v1/boxes/box-a') return Response.json(box('running'));
    throw new Error(`unexpected request ${path}`);
  };
  const instance = provider(fetch, { revisionId: 'rev-default' });
  await instance.create('profile-a', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
    metadata: { projectId: 'p1', cellboxTemplateId: 'tpl-override' } });
  assert.deepEqual(requests.find(request => request.path === '/v1/boxes')?.body,
    { ownerKey: 'project:p1', templateId: 'tpl-override' });
});

test('current image identity resolves the configured template stable revision', async () => {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === '/v1/profiles') return Response.json([profile]);
    if (path === '/v1/templates/tpl-a') return Response.json({ id: 'tpl-a', stableRevisionId: 'rev-stable' });
    if (path === '/v1/template-revisions/rev-stable') return Response.json({ id: 'rev-stable', image: 'sha256:image-a' });
    throw new Error(`unexpected request ${path}`);
  };
  const instance = provider(fetch, { templateId: 'tpl-a' });
  assert.deepEqual(await instance.currentImageIdentity(), {
    reference: 'sha256:image-a', id: 'sha256:image-a', repoDigests: ['sha256:image-a'],
  });
  assert.deepEqual(requests, ['/v1/profiles', '/v1/templates/tpl-a', '/v1/template-revisions/rev-stable']);
});

test('ensureRunning returns running state from GET and makes one explicit resume for suspended state', async () => {
  let phase: 'running' | 'suspended' = 'running';
  const posts: Array<{ path: string; body?: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/profiles') return Response.json([profile]);
    if (path === '/v1/boxes/box-a' && init?.method !== 'POST') return Response.json(box(phase));
    if (path === '/v1/boxes/box-a:resume') {
      posts.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      phase = 'running';
      return Response.json(op('resume'));
    }
    if (path === '/v1/operations/op-a') return Response.json(op('resume'));
    throw new Error(`unexpected request ${path}`);
  };
  const instance = provider(fetch, { revisionId: 'rev-a' });
  await instance.ensureRunning('box-a', { operationKey: 'legacy-operation-key' });
  assert.equal(posts.length, 0, 'already running is read-only');
  phase = 'suspended';
  await instance.ensureRunning('box-a', { operationKey: 'legacy-operation-key', expectedGeneration: 4 });
  assert.deepEqual(posts, [{ path: '/v1/boxes/box-a:resume', body: { expectedGeneration: 4 } }]);
});

test('a resume conflict is surfaced without a second mutation', async () => {
  let submissions = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/profiles') return Response.json([profile]);
    if (path === '/v1/boxes/box-a') return Response.json(box('suspended'));
    if (path === '/v1/boxes/box-a:resume') {
      submissions++;
      return Response.json({ error: { code: 'CONFLICT', message: 'generation changed' } }, { status: 409 });
    }
    throw new Error(`unexpected request ${path}`);
  };
  const instance = provider(fetch, { revisionId: 'rev-a' });
  await assert.rejects(instance.ensureRunning('box-a', { operationKey: 'ignored' }),
    error => error instanceof CellboxError && error.code === 'CONFLICT');
  assert.equal(submissions, 1);
});

test('connect joins an existing resume using GET polling only', async () => {
  const requests: string[] = [];
  let polls = 0;
  const fetch: typeof globalThis.fetch = async input => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/v1/profiles') return Response.json([profile]);
    if (url.pathname === '/v1/boxes/box-a') return Response.json(polls ? box('running') : box('resuming', { operationId: 'op-a' }));
    if (url.pathname === '/v1/operations/op-a') { polls++; return Response.json(op('resume')); }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const instance = provider(fetch, { revisionId: 'rev-a' });
  assert.equal((await instance.connect('box-a')).sandboxId, 'box-a');
  assert.equal(requests.some(request => request.includes(':resume')), false);
  assert.deepEqual(requests.filter(request => request.includes('/v1/operations/')), ['/v1/operations/op-a']);
  assert.equal(requests.at(-1), '/v1/boxes/box-a');
});

test('archive capture has no body and diskOnly is explicitly unsupported', async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, body: init?.body });
    return Response.json(op('archive'));
  } });
  await client.captureArchive('box-a');
  assert.equal(calls[0].path, '/v1/boxes/box-a/archives');
  assert.equal(calls[0].body, undefined);
  assert.throws(() => client.captureArchive('box-a', undefined, { diskOnly: true }),
    error => error instanceof CellboxError && error.code === 'UNSUPPORTED_CAPABILITY');
});

test('accepted mutation responses that cannot be decoded stay unknown and are never resubmitted', async () => {
  for (const response of [
    new Response('invalid JSON', { status: 202 }),
    new Response('{}', { status: 202, headers: { 'Content-Length': String(9 * 1024 * 1024) } }),
  ]) {
    let submissions = 0;
    const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async () => { submissions++; return response; } });
    await assert.rejects(client.createBox({ ownerKey: 'project:p1', revisionId: 'rev-a' }),
      error => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME' && error.status === 202);
    assert.equal(submissions, 1);
  }
});
