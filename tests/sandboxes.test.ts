import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SandboxInfo, SandboxMetrics } from 'e2b';
import { E2BSandboxInventory, EnvdMetricsReader } from '../server/sandboxes.js';
import { createApp } from '../server/app.js';
import type { SessionManager } from '../server/manager.js';
import type { AppConfig, ProjectSummary, SessionSummary } from '../shared/types.js';

const settings: AppConfig['defaults'] = { executionMode: 'e2b', workingDirectory: '/home/user/workspace', model: '', modelReasoningEffort: 'medium', sandboxMode: 'workspace-write', webSearchMode: 'disabled', networkAccessEnabled: true };
const config: AppConfig = { defaults: settings, sdkVersion: 'test', auth: 'api-key', approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false } };
const date = new Date('2026-09-06T07:00:00Z');
function sandbox(id: string, state: SandboxInfo['state'] = 'running'): SandboxInfo {
  return { sandboxId: id, templateId: 'template-id', name: 'base', metadata: { sessionId: 'forged-session', secret: 'never-expose-metadata' }, startedAt: date, endAt: new Date(date.getTime() + 60_000), state, cpuCount: 2, memoryMB: 512, envdVersion: 'test' };
}
function session(id: string, sandboxId: string): SessionSummary {
  return { id, title: 'My task', threadId: null, settings, status: 'completed', createdAt: date.toISOString(), updatedAt: date.toISOString(), turnCount: 1, sandbox: { id: sandboxId, status: 'ready', template: 'base', workingDirectory: settings.workingDirectory } };
}
function metrics(offset = 0): SandboxMetrics {
  return { timestamp: new Date(date.getTime() + offset), cpuUsedPct: 23.5, cpuCount: 2, memUsed: 123456, memTotal: 512 * 1024 * 1024, memCache: 100, diskUsed: 4096, diskTotal: 8192 };
}
function pages(...items: SandboxInfo[][]) {
  let next = 0;
  return { get hasNext() { return next < items.length; }, async nextItems() { return items[next++]; } };
}

test('inventory paginates all states, associates persisted sessions only and never samples paused VMs', async () => {
  const requests: string[] = [];
  const service = new E2BSandboxInventory({ apiKey: 'private-api-key' }, {
    list(options) {
      assert.deepEqual(options.query, { state: ['running', 'paused'] });
      return pages([sandbox('owned')], [sandbox('paused', 'paused'), sandbox('external')]);
    },
    async getMetrics(id) { requests.push(id); return [metrics(5000), metrics(0)]; },
  });
  const result = await service.read([session('own-session', 'owned'), session('deleted-sandbox-session', 'gone')]);
  assert.equal(result.sandboxes.length, 3);
  assert.deepEqual(requests.sort(), ['external', 'owned']);
  const own = result.sandboxes.find(s => s.id === 'owned')!;
  assert.deepEqual(own.session, { id: 'own-session', title: 'My task', status: 'completed' });
  assert.equal(own.metrics?.timestamp, metrics(5000).timestamp.toISOString());
  assert.equal(own.metrics?.memUsedBytes, 123456);
  assert.equal(result.sandboxes.find(s => s.id === 'external')?.session, null);
  assert.equal(result.sandboxes.find(s => s.id === 'paused')?.metricsStatus, 'paused');
  assert.equal(result.sandboxes.find(s => s.id === 'paused')?.metrics, null);
  assert.doesNotMatch(JSON.stringify(result), /private-api-key|never-expose-metadata|forged-session/);
});

test('metrics failures and missing samples preserve other sandbox results without inventing zero usage', async () => {
  const service = new E2BSandboxInventory({}, {
    list: () => pages(['ok', 'failed', 'pending', 'malformed', 'disk-missing'].map(id => sandbox(id))),
    async getMetrics(id) {
      if (id === 'failed') throw new Error('upstream secret-api-key');
      if (id === 'pending') return [];
      if (id === 'malformed') return [{ ...metrics(), cpuUsedPct: NaN }];
      if (id === 'disk-missing') return [{ ...metrics(), diskUsed: undefined, diskTotal: undefined } as unknown as SandboxMetrics];
      return [metrics()];
    },
  });
  const result = await service.read([]);
  const rows = Object.fromEntries(result.sandboxes.map(s => [s.id, s]));
  assert.equal(rows.ok.metricsStatus, 'available');
  assert.equal(rows.failed.metricsStatus, 'unavailable');
  assert.equal(rows.pending.metricsStatus, 'pending');
  assert.equal(rows.malformed.metricsStatus, 'unavailable');
  assert.equal(rows.failed.metrics, null);
  assert.equal(rows.pending.metrics, null);
  assert.equal(rows['disk-missing'].metrics?.diskUsedBytes, null);
  assert.doesNotMatch(JSON.stringify(result), /secret-api-key/);
});

test('concurrent refreshes share one fetch and resource calls are bounded while cached associations stay current', async () => {
  let listing = 0;
  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new E2BSandboxInventory({}, {
    list: () => { listing++; return pages(Array.from({ length: 9 }, (_, i) => sandbox(`vm-${i}`))); },
    async getMetrics(_id, options) {
      assert.equal(options.requestTimeoutMs, 4000);
      assert.ok(options.signal);
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return [metrics()];
    },
  });
  const first = service.read([]);
  const second = service.read([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listing, 1);
  assert.equal(maximum, 4);
  release();
  await Promise.all([first, second]);
  const latest = await service.read([session('new-association', 'vm-0')]);
  assert.equal(listing, 1);
  assert.equal(latest.sandboxes.find(s => s.id === 'vm-0')?.session?.id, 'new-association');
});

test('inventory HTTP endpoint reports sanitized list failure, retries and uses the existing host guard', async () => {
  let listing = 0;
  const service = new E2BSandboxInventory({}, {
    list: () => {
      listing++;
      if (listing === 1) return { hasNext: true, nextItems: async () => { throw new Error('api-key=secret-key upstream-body'); } };
      return pages([]);
    },
    getMetrics: async () => [],
  });
  const manager = { list: () => [], listProjects: () => [] } as unknown as SessionManager;
  const app = createApp(manager, config, ['localhost:3001'], undefined, service);
  const badHost = await app.request('/api/sandboxes', { headers: { host: 'evil.test' } });
  assert.equal(badHost.status, 403);
  assert.equal(listing, 0);
  const failed = await app.request('/api/sandboxes', { headers: { host: 'localhost:3001' } });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /secret-key|upstream-body/);
  const retry = await app.request('/api/sandboxes', { headers: { host: 'localhost:3001' } });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).sandboxes.length, 0);
  assert.equal(retry.headers.get('cache-control'), 'no-store');
});

test('unconfigured inventory returns an explicit disabled result without calling E2B', async () => {
  const unexpected = () => { throw new Error('must not call E2B'); };
  const service = new E2BSandboxInventory(undefined, { list: unexpected, getMetrics: unexpected });
  const result = await service.read([]);
  assert.equal(result.enabled, false);
  assert.deepEqual(result.sandboxes, []);
  assert.ok(Date.parse(result.fetchedAt));
});

test('inventory groups all project sessions and retains project ownership after its last session is deleted', async () => {
  let listing = 0;
  const service = new E2BSandboxInventory({}, {
    list: () => { listing++; return pages([sandbox('shared', 'paused'), sandbox('empty', 'paused')]); },
    getMetrics: async () => { throw new Error('paused sandboxes must not be sampled'); },
  });
  const project = (id: string, sandboxId: string, sessionCount: number): ProjectSummary => ({
    id, name: id, requirementUrl: null, executionMode: 'e2b', workingDirectory: settings.workingDirectory,
    sandbox: session('fixture', sandboxId).sandbox, createdAt: date.toISOString(), updatedAt: date.toISOString(), sessionCount, activeSessionId: null,
  });
  const projects = [project('owned-project', 'shared', 2), project('empty-project', 'empty', 0)];
  const first = { ...session('first', 'stale-session-mapping'), projectId: projects[0].id };
  const second = { ...session('second', 'shared'), projectId: projects[0].id };
  const inventory = await service.read([first, second], projects);
  const shared = inventory.sandboxes.find(s => s.id === 'shared')!;
  assert.deepEqual(shared.sessions?.map(s => s.id), ['first', 'second']);
  assert.equal(shared.project?.id, 'owned-project');
  assert.equal(shared.project?.sessionCount, 2);
  const empty = inventory.sandboxes.find(s => s.id === 'empty')!;
  assert.equal(empty.project?.id, 'empty-project');
  assert.deepEqual(empty.sessions, []);
  assert.equal(empty.session, null);
  const updated = await service.read([], [{ ...projects[0], name: 'Renamed', requirementUrl: 'https://example.feishu.cn/project/123', sessionCount: 0 }]);
  const retained = updated.sandboxes.find(s => s.id === 'shared')!;
  assert.equal(listing, 1, 'cached VM inventory must still reflect current ownership');
  assert.equal(retained.project?.name, 'Renamed');
  assert.equal(retained.project?.sessionCount, 0);
  assert.deepEqual(retained.sessions, []);
});

test('envd fallback refuses paused VMs and enabled or unknown auto-resume without contacting the sandbox', async () => {
  for (const extra of [
    { state: 'paused', lifecycle: { autoResume: false } },
    { state: 'running', lifecycle: { autoResume: true } },
    { state: 'running', lifecycle: {} },
    { state: 'running' },
  ]) {
    let requests = 0;
    const request: typeof fetch = async (input, init) => {
      requests++;
      const req = new Request(input, init);
      assert.equal(req.url, 'http://management.test/sandboxes/probe');
      return Response.json({ sandboxID: 'probe', envdAccessToken: 'private-envd-token', ...extra });
    };
    const reader = new EnvdMetricsReader({ apiKey: 'private-api-key', apiUrl: 'http://management.test', sandboxUrl: 'http://proxy.test' }, request);
    assert.equal(await reader.read('probe', AbortSignal.timeout(1000)), null);
    assert.equal(requests, 1);
  }
});

test('envd fallback uses separate API and sandbox credentials, configured routes and never returns tokens', async () => {
  const request: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    assert.equal(req.method, 'GET');
    assert.equal(req.redirect, 'error');
    if (req.url === 'http://management.test/sandboxes/probe') {
      assert.equal(req.headers.get('x-api-key'), 'private-api-key');
      return Response.json({ sandboxID: 'probe', state: 'running', lifecycle: { autoResume: false }, envdAccessToken: 'private-envd-token', domain: 'untrusted-redirect.test' });
    }
    assert.equal(req.url, 'http://proxy.test/metrics');
    assert.equal(req.headers.get('x-api-key'), null);
    assert.equal(req.headers.get('x-access-token'), 'private-envd-token');
    assert.equal(req.headers.get('e2b-sandbox-id'), 'probe');
    assert.equal(req.headers.get('e2b-sandbox-port'), '49983');
    return Response.json({ ts: Math.floor(Date.now() / 1000), cpu_used_pct: 13.25, cpu_count: 1, mem_used: 123456, mem_total: 512000000, disk_used: 500, disk_total: 1000 });
  };
  const reader = new EnvdMetricsReader({ apiKey: 'private-api-key', apiUrl: 'http://management.test', sandboxUrl: 'http://proxy.test' }, request);
  const service = new E2BSandboxInventory({}, { list: () => pages([sandbox('probe'), sandbox('paused', 'paused')]), getMetrics: async () => [] }, reader);
  const result = await service.read([]);
  const row = result.sandboxes.find(s => s.id === 'probe')!;
  assert.equal(row.metricsStatus, 'available');
  assert.equal(row.metricsSource, 'envd');
  assert.equal(row.metrics?.cpuUsedPct, 13.25);
  assert.equal(row.metrics?.memUsedBytes, 123456);
  assert.equal(row.metrics?.diskTotalBytes, 1000);
  assert.equal(result.sandboxes.find(s => s.id === 'paused')?.metrics, null);
  assert.doesNotMatch(JSON.stringify(result), /private-envd-token|private-api-key|untrusted-redirect/);
});

test('failed direct sampling stays isolated and historical samples retain their timestamp', async () => {
  const service = new E2BSandboxInventory({}, {
    list: () => pages([sandbox('historical'), sandbox('empty')]),
    getMetrics: async id => id === 'historical' ? [metrics()] : [],
  }, { read: async () => { throw new Error('private-envd-token'); } });
  const result = await service.read([]);
  const row = result.sandboxes.find(s => s.id === 'historical')!;
  assert.equal(row.metricsSource, 'e2b');
  assert.equal(row.metrics?.timestamp, date.toISOString());
  assert.equal(result.sandboxes.find(s => s.id === 'empty')?.metricsStatus, 'pending');
  assert.doesNotMatch(JSON.stringify(result), /private-envd-token/);
});
