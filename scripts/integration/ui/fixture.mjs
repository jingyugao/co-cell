import { test as base, expect } from '@playwright/test';

const now = '2026-01-01T00:00:00Z';
const defaultRoleId = '00000000-0000-4000-8000-000000000001';
const defaultRole = { id: defaultRoleId, name: '默认角色', connections: [], createdAt: now, updatedAt: now };
const workingDirectory = '/home/agent/workspace';
const defaults = { executionMode: 'sandbox', workingDirectory, model: 'integration-model', modelReasoningEffort: 'medium', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
const sandbox = (id, status = 'ready') => ({ id: `${id}-box`, status, template: 'default', workingDirectory });
const operation = (kind, status = 'running', error) => ({ id: `operation-${kind}`, kind, status, error, phase: '准备环境', updatedAt: now });
const project = (id, name, status = 'paused') => ({ id, name, status: 'active', type: 1, requirementUrl: null, executionMode: 'sandbox', workingDirectory, createdAt: now, updatedAt: now, sessionCount: 0, activeSessionId: null, sandbox: sandbox(id, status) });

export const test = base.extend({
  ui: async ({ page }, use) => {
    // Deterministic API boundaries make pending/error transitions reproducible.
    // These cases test the real React application, separately from the live suites.
    const projects = new Map([['paused', project('paused', '暂停项目')], ['other', project('other', '另一个项目', 'ready')]]);
    const projectRoles = new Map([...projects.keys()].map(id => [id, defaultRoleId]));
    const calls = [], historyReads = [], submissions = [], errors = [];
    const pendingRoutes = new Map(), pendingByRequest = new Map();
    const rememberPending = (id, route, kind, call) => {
      const pending = pendingRoutes.get(id) ?? new Set();
      const record = { route, kind, call };
      pending.add(record); pendingRoutes.set(id, pending); pendingByRequest.set(route.request(), { id, record });
    };
    const forgetPending = (id, record) => {
      const pending = pendingRoutes.get(id);
      pending?.delete(record);
      if (!pending?.size) pendingRoutes.delete(id);
      pendingByRequest.delete(record.route.request());
    };
    const fulfillPending = async (id, { status = 200, error } = {}) => {
      const pending = [...(pendingRoutes.get(id) ?? [])];
      await Promise.all(pending.map(async record => {
        const { route, kind } = record;
        forgetPending(id, record);
        try {
          const responseStatus = error ? 500 : kind === 'create' ? 201 : status;
          const data = error ? { error } : projects.get(id);
          record.call.status = responseStatus;
          await route.fulfill({ status: responseStatus, json: data });
        } catch { /* The browser may have cancelled its wait while the durable operation continues. */ }
      }));
    };
    page.on('requestfailed', request => {
      const pending = pendingByRequest.get(request);
      if (pending) forgetPending(pending.id, pending.record);
    });
    const session = { id: 'old-session', projectId: 'paused', title: '旧会话', threadId: 'existing-thread', status: 'idle', settings: defaults, turns: [], archivedAt: null, createdAt: now, updatedAt: now };
    const secondSession = { ...session, id: 'second-session', title: '同项目的另一个会话', threadId: 'second-thread' };
    const sessions = new Map([[session.id, session], [secondSession.id, secondSession]]);
    const config = { defaults, sandbox: { provider: 'cellbox', enabled: true, image: 'default', workingDirectory }, codexVersion: 'integration', approvalPolicy: 'never', auth: 'api-key', capabilities: { interactiveApprovals: false, tokenDeltas: false, sandboxPreviews: true } };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      const waitForOperation = url.searchParams.get('waitForOperation');
      const call = { path, method, ...(waitForOperation ? { waitForOperation } : {}) };
      calls.push(call);
      let data, status = 200;
      if (path === '/api/config') data = config;
      else if (path === '/api/tool-roles' && method === 'GET') data = { roles: [defaultRole], defaultRoleId };
      else if (path === '/api/notifications') data = [];
      else if (path === '/api/images') data = [{ id: 'default', name: '系统默认镜像', category: '系统', origin: 'profile', versions: [{ id: 'default', version: '当前配置', status: 'succeeded', source: 'default', projectReady: true }] }];
      else if (path === '/api/projects' && method === 'GET') data = [...projects.values()];
      else if (path === '/api/projects' && method === 'POST') {
        data = project('new', request.postDataJSON().name); delete data.sandbox;
        data.sandboxOperation = operation('create'); projects.set('new', data); projectRoles.set('new', defaultRoleId);
        rememberPending('new', route, 'create', call); return;
      } else if (path.startsWith('/api/projects/')) {
        const id = path.split('/')[3]; data = projects.get(id);
        if (!data) { data = { error: '不存在' }; status = 404; }
        else if (path === `/api/projects/${id}/tool-role`) {
          if (method === 'PUT') projectRoles.set(id, request.postDataJSON().roleId);
          data = { roleId: projectRoles.get(id) ?? null, connections: [] };
        }
        else if (method === 'PATCH' && path === `/api/projects/${id}`) {
          const next = request.postDataJSON();
          if (next.status !== undefined) { data.status = next.status; data.completedAt = next.status === 'completed' ? now : null; }
        }
        else if (method === 'POST' && path.endsWith('/archive')) {
          data.status = 'archived'; data.archivedAt = now; delete data.sandbox;
          delete data.archiveCleanupSourceId; delete data.pendingSandboxCleanup;
          data.sandboxOperation = operation('archive', 'succeeded');
        } else if (method === 'POST' && path.endsWith('/sandbox/release')) {
          delete data.sandbox;
          data.sandboxReclaimedAt = now;
          data.sandboxOperation = operation('release', 'succeeded');
          status = 200;
        }
        else if (method === 'POST' && path.endsWith('/open')) {
          if (data.sandbox?.status === 'ready' && data.sandboxOperation?.status !== 'running') {
            data.sandboxOperation = operation('resume', 'succeeded');
            status = 200;
          } else {
            if (!(data.sandboxOperation?.kind === 'checkpoint' && data.sandboxOperation.status === 'running'))
              data.sandboxOperation = operation('resume');
            rememberPending(id, route, 'open', call); return;
          }
        } else if (method === 'POST' && path.endsWith('/resume')) {
          data.sandboxOperation = operation('resume');
          rememberPending(id, route, 'resume', call); return;
        } else if (method === 'POST' && path.endsWith('/backup')) {
          data.sandboxOperation = operation('backup', 'succeeded');
          data.sandboxBackup = { id: data.sandboxOperation.id, sandboxId: data.sandbox.id, status: 'succeeded', phase: '完成', updatedAt: now };
          status = 200;
        } else if (method === 'POST' && path.endsWith('/sandbox/checkpoint')) {
          if (data.sandbox?.status === 'paused') {
            data.sandboxOperation = operation('checkpoint', 'succeeded');
            status = 200;
          } else {
            data.sandboxOperation = operation('checkpoint');
            rememberPending(id, route, 'checkpoint', call); return;
          }
        } else if (method === 'POST' && (path.endsWith('/sandbox/create') || path.endsWith('/sandbox/restore') || path.endsWith('/rebuild'))) {
          const kind = path.endsWith('/sandbox/restore') ? 'restore' : path.endsWith('/sandbox/create') ? 'create' : data.sandbox ? 'rebuild' : 'create';
          data.sandboxOperation = operation(kind);
          rememberPending(id, route, kind, call); return;
        }
      } else if (path === '/api/sessions' && method === 'GET') data = [...sessions.values()];
      else if (path.startsWith('/api/sessions/') && path.endsWith('/events')) {
        const currentSession = sessions.get(path.split('/')[3]);
        await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'snapshot', session: currentSession })}\n\n` }); return;
      } else if (path.startsWith('/api/sessions/') && path.split('/').length === 4 && method === 'GET') {
        const currentSession = sessions.get(path.split('/')[3]);
        historyReads.push(path); data = { ...currentSession, turns: currentSession.turns.length ? currentSession.turns : [{ id: 'old-turn', prompt: '历史任务内容', images: [], items: [], status: 'completed', startedAt: now, completedAt: now }] };
      } else if (path.endsWith('/turns') && method === 'POST') {
        const currentSession = sessions.get(path.split('/')[3]);
        const input = request.postDataJSON(); submissions.push(input);
        data = { turnId: currentSession.turns.at(-1)?.id ?? 'old-turn' }; status = 202;
      } else if (path.endsWith('/subagents')) data = [];
      else { errors.push(`Unexpected API call: ${method} ${path}`); data = { error: 'Unexpected test API call' }; status = 500; }
      if (!request.failure()) {
        call.status = status;
        await route.fulfill({ status, json: data });
      }
    });
    const ui = {
      projects, calls, historyReads, submissions, sessions,
      editor: page.getByRole('textbox', { name: '任务描述', exact: true }),
      send: page.getByRole('button', { name: '发送任务', exact: true }),
      setRunning() { session.status = 'running'; session.turns = [{ id: 'native-turn', nativeTurnId: 'native-turn', prompt: '原始任务', additionalUserInputs: ['相同补充', '相同补充'], images: [], items: [], status: 'running', codexAccepted: true, startedAt: now }]; },
      count: (method, path) => calls.filter(call => call.path === path && call.method === method).length,
      async complete(id) {
        const value = projects.get(id);
        const restoring = value.sandbox?.status === 'unavailable' && Boolean(value.remoteArchives?.length || value.latestBackup);
        value.sandbox = sandbox(id, 'ready');
        delete value.sandboxReclaimedAt;
        if (restoring) value.sandbox.id = `${id}-restored-box`;
        value.sandboxOperation = operation(value.sandboxOperation?.kind ?? 'create', 'succeeded');
        await fulfillPending(id);
      },
      async fail(id, message) {
        const value = projects.get(id);
        value.sandboxOperation = operation(value.sandboxOperation?.kind ?? 'resume', 'failed', message);
        await fulfillPending(id, { error: message });
      },
      async checkpoint(id, running) {
        const value = projects.get(id);
        value.sandbox = sandbox(id, running ? 'ready' : 'paused');
        value.sandboxOperation = operation('checkpoint', running ? 'running' : 'succeeded');
        if (!running) {
          const pending = [...(pendingRoutes.get(id) ?? [])];
          const entries = pending.filter(record => record.kind === 'open');
          if (entries.length) value.sandboxOperation = operation('resume');
          await Promise.all(pending.filter(record => record.kind === 'checkpoint').map(async record => {
            forgetPending(id, record);
            record.call.status = 200;
            try { await record.route.fulfill({ status: 200, json: value }); } catch { /* Browser cancellation leaves the durable operation intact. */ }
          }));
        }
      },
    };
    try { await use(ui); }
    finally {
      await Promise.all([...pendingRoutes.entries()].flatMap(([id, records]) => [...records].map(async record => {
        forgetPending(id, record);
        try { await record.route.abort(); } catch { /* Request already completed or cancelled. */ }
      })));
    }
    expect(errors).toEqual([]);
  },
});
export { expect };

export async function projectList(page) {
  const menu = page.getByRole('button', { name: '打开导航', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.locator('.sidebar').getByRole('button', { name: '项目管理', exact: true }).click();
}
export async function createThroughUI(page, name) {
  await page.getByRole('button', { name: '＋ 创建项目', exact: true }).click();
  const form = page.getByRole('form', { name: '创建项目', exact: true });
  await form.getByLabel('项目名称', { exact: true }).fill(name);
  await form.getByRole('button', { name: '创建项目', exact: true }).click();
}
