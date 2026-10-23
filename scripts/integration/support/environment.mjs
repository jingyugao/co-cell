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
    this.roles = new Map();
    this.sessions = new Set();
    this.boxes = new Set();
    this.transports = [];
    this.controller = new AbortController();
    this.journal = journal;
    this.pendingWrite = Promise.resolve();
    this.testStep = step;
    this.report = { runId: this.runId, prefix: this.prefix, target: config.publicURL.origin, startedAt: new Date().toISOString(), steps: [], requests: [], cleanup: [] };
  }
  redact(value) {
    return [this.config.token, process.env.CODEX_API_KEY, process.env.OPENAI_API_KEY].filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value));
  }
  async captureFailure() {
    this.report.failedSessions = [];
    for (const id of this.sessions) {
      try {
        const session = await this.json(`/api/sessions/${id}`, { signal: AbortSignal.timeout(10_000) });
        this.report.failedSessions.push({ id, status: session.status, threadId: session.threadId, historyError: session.historyError,
          turns: session.turns.map(turn => ({ id: turn.id, prompt: turn.prompt, status: turn.status, error: turn.error,
            items: turn.items.map(item => ({ type: item.type, status: item.status, text: item.text,
              command: item.command, exit_code: item.exit_code, aggregated_output: item.aggregated_output,
              message: item.message, error: item.error })) })) });
      } catch (error) { this.report.failedSessions.push({ id, error: this.redact(error.message) }); }
    }
    await this.persist();
  }
  name(label) { return `${this.prefix} ${label}`; }
  async persist() {
    if (!this.journal) return;
    const data = this.redact(JSON.stringify({ ...this.report, projects: [...this.projects], roles: [...this.roles], sessions: [...this.sessions], boxes: [...this.boxes] }, null, 2));
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
      catch (error) {
        entry.status = 'failed'; entry.error = this.redact(error.message ?? String(error));
        const failure = new Error(entry.error);
        // Retain the original assertion location without leaking its raw properties.
        if (error.stack) failure.stack = this.redact(error.stack);
        throw failure;
      }
      finally { entry.durationMs = performance.now() - start; await this.persist(); }
    });
  }
  checkMutation(path, method, body) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
    if (path === '/api/projects' && method === 'POST') {
      assert(body?.name?.startsWith(`${this.prefix} `), 'Test projects must use the current run prefix');
      return;
    }
    if (path === '/api/tool-roles' && method === 'POST') {
      assert(body?.name?.startsWith(`${this.prefix} `), 'Test roles must use the current run prefix');
      return;
    }
    const role = /^\/api\/tool-roles\/([0-9a-f-]{36})$/.exec(path)?.[1];
    if (role && method === 'DELETE') {
      assert(this.roles.has(role), 'Cannot delete an unowned role');
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
      const createdProject = method === 'POST' && path === '/api/projects' && response.status === 201 && data?.id;
      if (method === 'POST' && path === '/api/tool-roles' && response.status === 201 && data?.id) {
        this.roles.set(data.id, options.body.name); await this.persist();
      }
      if (method === 'DELETE' && path.startsWith('/api/tool-roles/') && response.ok) {
        this.roles.delete(path.split('/').at(-1)); await this.persist();
      }
      if (createdProject) {
        this.projects.set(data.id, options.body.name); await this.persist();
      }
      if (method === 'POST' && path === '/api/sessions' && response.status === 201 && data.id) {
        this.sessions.add(data.id); await this.persist();
      }
      if (data?.id && this.projects.has(data.id) && data.sandbox?.id) this.boxes.add(data.sandbox.id);
      if (createdProject) {
        await this.persist();
        assert.equal(data.sandboxOperation?.status, 'succeeded', 'Project creation response must contain a completed sandbox operation');
        assert.equal(data.sandbox?.status, 'ready', 'Project creation response must contain a ready sandbox');
      }
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
  async waitProject(id, { kind, status, operationId, waitForBackup = false } = {}) {
    const deadline = Date.now() + this.config.operationTimeout;
    while (Date.now() < deadline) {
      const project = await this.json(`/api/projects/${id}`, { timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())) });
      const operation = project.sandboxOperation;
      if (kind) assert.equal(operation?.kind, kind, 'Unexpected project operation');
      if (operationId) assert.equal(operation?.id, operationId, 'Operation was replaced while waiting');
      if (operation?.status === 'failed') throw new Error(this.redact(operation.error ?? 'Project operation failed'));
      if (operation?.status === 'succeeded') {
        if (waitForBackup) {
          const backupStatus = project.sandboxBackup?.status;
          if (backupStatus === 'failed') throw new Error(this.redact(project.sandboxBackup.error ?? 'Project disk backup failed'));
          if (backupStatus !== 'succeeded') {
            await delay(250, undefined, { signal: this.controller.signal });
            continue;
          }
        }
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
        const deadline = Date.now() + this.config.operationTimeout;
        const stoppedSessions = new Set();
        let beforeDelete;
        for (;;) {
          const { data: project, response } = await this.request(`/api/projects/${id}`, { signal, expectedStatus: [200, 404] });
          if (response.status === 404) break;
          assert.equal(project.name, name, 'Project ownership changed; refusing cleanup');
          if (project.sandbox?.id) this.boxes.add(project.sandbox.id);
          if (project.activeSessionId && !stoppedSessions.has(project.activeSessionId)) {
            const sessions = await this.json('/api/sessions', { signal });
            assert(sessions.some(session => session.id === project.activeSessionId && session.projectId === id), 'Active session ownership is unknown');
            this.sessions.add(project.activeSessionId);
            await this.json(`/api/sessions/${project.activeSessionId}/stop`, { method: 'POST', signal });
            stoppedSessions.add(project.activeSessionId);
          }
          const waiting = Boolean(project.activeSessionId)
            || project.sandboxOperation?.status === 'running'
            || project.sandboxBackup?.status === 'running';
          if (waiting) {
            assert(Date.now() < deadline, `Timed out waiting for project ${id} operations and disk backup before DELETE`);
            await delay(250, undefined, { signal }); continue;
          }
          assert(!['unknown', 'failed'].includes(project.sandboxOperation?.status),
            `Project ${id} has a ${project.sandboxOperation?.status ?? 'unknown'} sandbox operation; cleanup will not replay it`);
          assert(!['failed', 'unknown'].includes(project.sandboxBackup?.status),
            `Project ${id} disk backup result is ${project.sandboxBackup?.status ?? 'unknown'}; cleanup will not replay it`);
          beforeDelete = project;
          const retainedBefore = (project.remoteArchives ?? []).map(reference => ({
            id: reference.id, storageType: reference.storageType ?? 'cellbox',
            volumeId: reference.volumeId, snapshotId: reference.snapshotId,
          }));
          await this.json(`/api/projects/${id}`, { method: 'DELETE', timeoutMs: this.config.operationTimeout, signal });
          await this.request(`/api/projects/${id}`, { signal, expectedStatus: 404 });
          const archiveIndex = await this.json('/api/archives', { signal });
          const retained = archiveIndex.filter(item => item.projectId === id).flatMap(item => item.archives ?? []);
          const retainedSnapshots = retained.map(reference => ({
            id: reference.key, storageType: reference.storageType,
            volumeId: reference.volumeId, snapshotId: reference.snapshotId,
          }));
          const mounts = beforeDelete.sandboxMounts ?? beforeDelete.sandbox?.mounts ?? [];
          const knownVolumeIds = new Set([
            ...mounts.map(mount => mount.volumeId),
            ...(beforeDelete.remoteArchives ?? []).flatMap(reference => reference.volumeId ? [reference.volumeId] : []),
          ]);
          for (const volumeId of knownVolumeIds) {
            assert(retainedSnapshots.some(reference => reference.volumeId === volumeId),
              `Project ${id} DELETE did not retain a snapshot for Volume ${volumeId}`);
          }
          if (!mounts.length && retainedBefore.length) {
            const latestExisting = retainedBefore[0];
            assert(retainedSnapshots.some(reference => reference.id === latestExisting.id),
              `Project ${id} DELETE pruned the latest existing recovery snapshot ${latestExisting.id}`);
          }
          this.report.cleanup.push({ projectId: id, status: 'deleted_retained_backups', retainedSnapshots });
          break;
        }
        if (!beforeDelete) this.report.cleanup.push({ projectId: id, status: 'already_removed' });
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
    if (!this.config.keepProjects) {
      try {
        const catalog = await this.json('/api/tool-roles', { signal });
        for (const role of catalog.roles) {
          if (!role.name.startsWith(`${this.prefix} `)) continue;
          assert(role.id !== catalog.defaultRoleId, 'Refusing to delete the installation default role');
          const expectedName = this.roles.get(role.id);
          if (expectedName) assert.equal(role.name, expectedName, 'Role ownership changed; refusing cleanup');
          this.roles.set(role.id, role.name);
          await this.json(`/api/tool-roles/${role.id}`, { method: 'DELETE', signal });
          this.report.cleanup.push({ roleId: role.id, status: 'deleted' });
        }
      } catch (error) { errors.push(this.redact(error.message)); }
    }
    this.report.finishedAt = new Date().toISOString();
    await this.persist();
    assert.equal(errors.length, 0, `Integration cleanup failed: ${errors.join('; ')}`);
  }
}
