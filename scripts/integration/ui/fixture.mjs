import { test as base, expect } from '@playwright/test';

const now = '2026-01-01T00:00:00Z';
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
    const calls = [], historyReads = [], submissions = [], errors = [];
    const waiters = new Map(), cancelled = new Map();
    const notify = id => { for (const finish of waiters.get(id) ?? []) finish(); };
    page.on('requestfailed', request => cancelled.get(request)?.());
    const session = { id: 'old-session', projectId: 'paused', title: '旧会话', threadId: 'existing-thread', status: 'idle', settings: defaults, turns: [], archivedAt: null, createdAt: now, updatedAt: now };
    const config = { defaults, sandbox: { provider: 'cellbox', enabled: true, image: 'default', workingDirectory }, codexVersion: 'integration', approvalPolicy: 'never', auth: 'api-key', capabilities: { interactiveApprovals: false, tokenDeltas: false, sandboxPreviews: true } };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      const waitForOperation = url.searchParams.get('waitForOperation');
      calls.push({ path, method, ...(waitForOperation ? { waitForOperation } : {}) });
      let data, status = 200;
      if (path === '/api/config') data = config;
      else if (path === '/api/notifications') data = [];
      else if (path === '/api/images') data = [{ id: 'default', name: '系统默认镜像', category: '系统', origin: 'profile', versions: [{ id: 'default', version: '当前配置', status: 'succeeded', source: 'default', projectReady: true }] }];
      else if (path === '/api/projects' && method === 'GET') data = [...projects.values()];
      else if (path === '/api/projects' && method === 'POST') {
        data = project('new', request.postDataJSON().name); delete data.sandbox;
        data.sandboxOperation = operation('create'); projects.set('new', data); status = 201;
      } else if (path.startsWith('/api/projects/')) {
        const id = path.split('/')[3]; data = projects.get(id);
        if (!data) { data = { error: '不存在' }; status = 404; }
        else if (method === 'GET' && path === `/api/projects/${id}` && waitForOperation
          && data.sandboxOperation?.id === waitForOperation && data.sandboxOperation.status === 'running') {
          await new Promise(resolve => {
            const pending = waiters.get(id) ?? new Set();
            const finish = () => {
              clearTimeout(timer); pending.delete(finish); cancelled.delete(request);
              if (!pending.size) waiters.delete(id);
              resolve();
            };
            const timer = setTimeout(finish, Number(url.searchParams.get('waitMs') ?? 10_000));
            pending.add(finish); waiters.set(id, pending); cancelled.set(request, finish);
          });
          data = projects.get(id);
        }
        else if (method === 'PATCH' && path === `/api/projects/${id}`) {
          const next = request.postDataJSON();
          if (next.status !== undefined) { data.status = next.status; data.completedAt = next.status === 'completed' ? now : null; }
        }
        else if (method === 'POST' && path.endsWith('/open')) {
          status = 202;
          if (data.sandbox?.status === 'paused' && data.sandboxOperation?.status !== 'running') data.sandboxOperation = operation('resume');
        } else if (method === 'POST' && path.endsWith('/rebuild')) { data.sandboxOperation = operation(data.sandbox ? 'rebuild' : 'create'); status = 202; }
      } else if (path === '/api/sessions' && method === 'GET') data = [session];
      else if (path === '/api/sessions/old-session/events') {
        await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'snapshot', session })}\n\n` }); return;
      } else if (path === '/api/sessions/old-session' && method === 'GET') {
        historyReads.push(path); data = { ...session, turns: session.turns.length ? session.turns : [{ id: 'old-turn', prompt: '历史任务内容', images: [], items: [], status: 'completed', startedAt: now, completedAt: now }] };
      } else if (path === '/api/sessions/old-session/turns' && method === 'POST') {
        const input = request.postDataJSON(); submissions.push(input);
        data = { turnId: session.turns.at(-1)?.id ?? 'old-turn' }; status = 202;
      } else if (path.endsWith('/subagents')) data = [];
      else { errors.push(`Unexpected API call: ${method} ${path}`); data = { error: 'Unexpected test API call' }; status = 500; }
      if (!request.failure()) await route.fulfill({ status, json: data });
    });
    const ui = {
      projects, calls, historyReads, submissions,
      editor: page.getByRole('textbox', { name: '任务描述', exact: true }),
      send: page.getByRole('button', { name: '发送任务', exact: true }),
      setRunning() { session.status = 'running'; session.turns = [{ id: 'native-turn', nativeTurnId: 'native-turn', prompt: '原始任务', additionalUserInputs: ['相同补充', '相同补充'], images: [], items: [], status: 'running', codexAccepted: true, startedAt: now }]; },
      count: (method, path) => calls.filter(call => call.path === path && call.method === method).length,
      complete(id) { const value = projects.get(id); value.sandbox = sandbox(id); value.sandboxOperation = operation(value.sandboxOperation?.kind ?? 'create', 'succeeded'); notify(id); },
      fail(id, message) { const value = projects.get(id); value.sandboxOperation = operation(value.sandboxOperation?.kind ?? 'resume', 'failed', message); notify(id); },
      checkpoint(id, running) { const value = projects.get(id); value.sandbox = sandbox(id, running ? 'ready' : 'paused'); value.sandboxOperation = operation('checkpoint', running ? 'running' : 'succeeded'); notify(id); },
    };
    try { await use(ui); }
    finally { for (const id of waiters.keys()) notify(id); }
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
