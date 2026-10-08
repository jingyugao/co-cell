import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

function positive(value, fallback, name) {
  const number = Number(value ?? fallback);
  assert(Number.isSafeInteger(number) && number > 0, `Invalid ${name}`);
  return number;
}
function origin(value, name) {
  assert(value, `${name} is required for live integration tests`);
  const url = new URL(value);
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', `${name} must be an HTTP(S) origin`);
  return url;
}
export function liveConfig(env = process.env) {
  const base = origin(env.COCELL_E2E_BASE_URL, 'COCELL_E2E_BASE_URL');
  assert(env.COCELL_E2E_ACCESS_TOKEN, 'COCELL_E2E_ACCESS_TOKEN is required for live integration tests');
  return {
    base, publicURL: origin(env.COCELL_E2E_PUBLIC_URL ?? base.href, 'COCELL_E2E_PUBLIC_URL'),
    token: env.COCELL_E2E_ACCESS_TOKEN, model: env.COCELL_E2E_MODEL ?? 'gpt-6-luna',
    operationTimeout: positive(env.COCELL_E2E_OPERATION_TIMEOUT_MS, 300_000, 'operation timeout'),
    turnTimeout: positive(env.COCELL_E2E_TURN_TIMEOUT_MS, 600_000, 'turn timeout'),
    readBudgetMs: positive(env.COCELL_E2E_READ_LATENCY_MS, 2000, 'read latency budget'),
    keepProjects: env.COCELL_E2E_KEEP_PROJECT === '1',
  };
}

/** One test owns one resource ledger. Only resources in this run can be mutated. */
export class LiveEnvironment {
  constructor(config, { journal, step = async (_name, run) => run() } = {}) {
    this.config = config;
    this.runId = randomUUID();
    this.prefix = `integration-${this.runId}`;
    this.projects = new Map();
    this.sessions = new Set();
    this.boxes = new Set();
    this.transports = [];
    this.controller = new AbortController();
    this.journal = journal;
    this.pendingWrite = Promise.resolve();
    this.testStep = step;
    this.report = { runId: this.runId, prefix: this.prefix, target: config.publicURL.origin, startedAt: new Date().toISOString(), steps: [], requests: [], cleanup: [] };
  }
  redact(value) { return String(value).replaceAll(this.config.token, '[redacted]'); }
  name(label) { return `${this.prefix} ${label}`; }
  async persist() {
    if (!this.journal) return;
    const data = this.redact(JSON.stringify({ ...this.report, projects: [...this.projects], sessions: [...this.sessions], boxes: [...this.boxes] }, null, 2));
    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.journal), { recursive: true });
      await writeFile(`${this.journal}.next`, data, { mode: 0o600 });
      await rename(`${this.journal}.next`, this.journal);
    });
    await this.pendingWrite;
  }
  async step(name, run) {
    return this.testStep(name, async () => {
      const entry = { name, startedAt: new Date().toISOString(), status: 'running' };
      this.report.steps.push(entry);
      await this.persist();
      const start = performance.now();
      try { entry.evidence = await run(); entry.status = 'passed'; return entry.evidence; }
      catch (error) { entry.status = 'failed'; entry.error = this.redact(error.message); throw new Error(entry.error); }
      finally { entry.durationMs = performance.now() - start; await this.persist(); }
    });
  }
  checkMutation(path, method, body) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
    if (path === '/api/projects' && method === 'POST') {
      assert(body?.name?.startsWith(`${this.prefix} `), 'Test projects must use the current run prefix');
      return;
    }
    if (path === '/api/sessions' && method === 'POST') {
      assert(this.projects.has(body?.projectId), 'Cannot create sessions in an unowned project');
      return;
    }
    const project = /^\/api\/projects\/([^/]+)/.exec(path)?.[1];
    const session = /^\/api\/sessions\/([^/]+)/.exec(path)?.[1];
    assert((project && this.projects.has(project)) || (session && this.sessions.has(session)), `Refusing mutation of an unowned resource: ${method} ${path}`);
  }
  async fetch(path, { method = 'GET', body, timeoutMs = 30_000, signal } = {}) {
    const url = new URL(path, this.config.base);
    assert(url.origin === this.config.base.origin, 'Cross-origin test requests are not allowed');
    this.checkMutation(url.pathname, method, body);
    const options = { method, headers: {
      Authorization: `Bearer ${this.config.token}`, Host: this.config.publicURL.host, Origin: this.config.publicURL.origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    }, signal: AbortSignal.any([signal ?? this.controller.signal, AbortSignal.timeout(timeoutMs)]) };
    // Native HTTP preserves an explicit public Host through a loopback forward.
    // No redirect following, shared proxy credentials, or ambient proxy settings.
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, incoming => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) headers.append(name, entry);
        }
        const empty = method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
        if (empty) incoming.resume();
        resolve(new Response(empty ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers }));
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async request(path, options = {}) {
    const method = options.method ?? 'GET';
    const expectedStatus = options.expectedStatus === undefined ? 200 : options.expectedStatus;
    const start = performance.now();
    try {
      const response = await this.fetch(path, options);
      // Drain the response: service leases must be released before checkpoint.
      const buffer = Buffer.from(await response.arrayBuffer());
      const text = buffer.toString('utf8');
      const data = method !== 'HEAD' && text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
      if (method === 'POST' && path === '/api/projects' && response.status === 201 && data.id) {
        this.projects.set(data.id, options.body.name); await this.persist();
      }
      if (method === 'POST' && path === '/api/sessions' && response.status === 201 && data.id) {
        this.sessions.add(data.id); await this.persist();
      }
      if (data?.id && this.projects.has(data.id) && data.sandbox?.id) this.boxes.add(data.sandbox.id);
      const durationMs = performance.now() - start;
      this.report.requests.push({ method, path, status: response.status, durationMs });
      if (expectedStatus !== null) assert((Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]).includes(response.status),
        `HTTP ${response.status}; ${text.slice(0, 800)}`);
      return { data, durationMs, bytes: buffer.length, buffer, response };
    } catch (error) { throw new Error(this.redact(`${method} ${path}: ${error.message}`)); }
  }
  async json(path, options) { return (await this.request(path, options)).data; }
  async createProject(label) {
    return this.json('/api/projects', { method: 'POST', expectedStatus: 201, body: { name: this.name(label), type: 1 } });
  }
  async waitProject(id, { kind, status, operationId } = {}) {
    const deadline = Date.now() + this.config.operationTimeout;
    while (Date.now() < deadline) {
      const project = await this.json(`/api/projects/${id}`, { timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())) });
      const operation = project.sandboxOperation;
      if (kind) assert.equal(operation?.kind, kind, 'Unexpected project operation');
      if (operationId) assert.equal(operation?.id, operationId, 'Operation was replaced while waiting');
      if (operation?.status === 'failed') throw new Error(this.redact(operation.error ?? 'Project operation failed'));
      if (operation?.status === 'succeeded') {
        if (status) assert.equal(project.sandbox?.status, status);
        return project;
      }
      await delay(250, undefined, { signal: this.controller.signal });
    }
    throw new Error(`Project ${id} operation timed out`);
  }
  async waitIdle(id) {
    const deadline = Date.now() + this.config.turnTimeout;
    while (Date.now() < deadline) {
      if (!(await this.json(`/api/projects/${id}`)).activeSessionId) return;
      await delay(300, undefined, { signal: this.controller.signal });
    }
    throw new Error(`Project ${id} still has an active model turn`);
  }
  async cleanup() {
    this.controller.abort();
    // Cleanup has its own deadline, independent of the failed test's cancellation.
    const signal = AbortSignal.timeout(this.config.operationTimeout + 30_000);
    const errors = [];
    try {
      // Also recover a create whose response was lost after server acceptance.
      for (const project of await this.json('/api/projects', { signal })) {
        if (project.name.startsWith(`${this.prefix} `)) this.projects.set(project.id, project.name);
      }
    } catch (error) { errors.push(this.redact(error.message)); }
    if (this.config.keepProjects) {
      this.report.cleanup.push({ status: 'retained', projectIds: [...this.projects.keys()] });
    } else for (const [id, name] of [...this.projects].reverse()) {
      try {
        for (;;) {
          const { data: project, response } = await this.request(`/api/projects/${id}`, { signal, expectedStatus: [200, 404] });
          if (response.status === 404) break;
          assert.equal(project.name, name, 'Project ownership changed; refusing cleanup');
          if (project.sandbox?.id) this.boxes.add(project.sandbox.id);
          if (project.activeSessionId) {
            const sessions = await this.json('/api/sessions', { signal });
            assert(sessions.some(session => session.id === project.activeSessionId && session.projectId === id), 'Active session ownership is unknown');
            this.sessions.add(project.activeSessionId);
            await this.json(`/api/sessions/${project.activeSessionId}/stop`, { method: 'POST', signal });
          }
          if (project.activeSessionId || project.sandboxOperation?.status === 'running') {
            await delay(250, undefined, { signal }); continue;
          }
          await this.json(`/api/projects/${id}`, { method: 'DELETE', timeoutMs: this.config.operationTimeout, signal });
          await this.request(`/api/projects/${id}`, { signal, expectedStatus: 404 });
          break;
        }
        this.report.cleanup.push({ projectId: id, status: 'deleted' });
      } catch (error) { const message = this.redact(error.message); errors.push(message); this.report.cleanup.push({ projectId: id, status: 'failed', error: message }); }
    }
    if (!this.config.keepProjects && this.boxes.size) {
      try {
        const inventory = await this.json('/api/sandboxes', { signal });
        assert(!inventory.sandboxes.some(box => this.boxes.has(box.id)), 'A test sandbox remains after project deletion');
      } catch (error) { errors.push(this.redact(error.message)); }
    }
    if (!this.config.keepProjects && this.sessions.size) {
      try {
        const sessions = await this.json('/api/sessions', { signal });
        assert(!sessions.some(session => this.sessions.has(session.id)), 'A test session remains after project deletion');
      } catch (error) { errors.push(this.redact(error.message)); }
    }
    this.report.finishedAt = new Date().toISOString();
    await this.persist();
    assert.equal(errors.length, 0, `Integration cleanup failed: ${errors.join('; ')}`);
  }
}
