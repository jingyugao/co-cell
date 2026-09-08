import { ImprovementStore } from './improvements/store.js';
import type { ImprovementContext, ImprovementReceipt } from '../shared/improvement-types.js';
import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { Codex } from '@openai/codex-sdk';
import { getRequestListener } from '@hono/node-server';
import type { AppConfig, Settings } from '../shared/types.js';
import { DEFAULT_MODEL } from '../shared/models.js';
import { createApp } from './app.js';
import { SessionManager } from './sessions/manager.js';
import { E2BCodexRuntime } from './sandboxes/e2b.js';
import { E2BSandboxInventory } from './sandboxes/inventory.js';
import { LocalSandboxArchiveStorage } from './sandboxes/archive-storage.js';
import { LocalSnapshotArchive } from './sandboxes/local-snapshot-archive.js';
import { TemplateManager } from './templates/manager.js';
import { ConnectionStore } from './connections/store.js';
import { RuntimeLog } from './diagnostics/runtime-log.js';
import { installProductionStatic } from './http/static-files.js';

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
const sdkConfig = process.env.CODEX_CONFIG_JSON ? JSON.parse(process.env.CODEX_CONFIG_JSON) : {};
// Built-in provider IDs cannot be overridden in Codex 0.153.4. Register the
// explicit proxy as a custom Responses provider to control its transport.
const proxyConfig = process.env.OPENAI_BASE_URL ? {
  model_provider: 'codex_web_proxy',
  model_providers: {
    codex_web_proxy: {
      name: 'Codex Web proxy',
      base_url: process.env.OPENAI_BASE_URL,
      wire_api: 'responses',
      supports_websockets: false,
      ...(apiKey ? { env_key: 'CODEX_API_KEY' } : { requires_openai_auth: true }),
    },
  },
} : {};
const modelConfig = {
  ...proxyConfig, ...sdkConfig,
  model_providers: { ...proxyConfig.model_providers, ...sdkConfig.model_providers },
};
const configOverrides = process.env.CODEX_CONFIG_OVERRIDES_JSON ? JSON.parse(process.env.CODEX_CONFIG_OVERRIDES_JSON) : undefined;
const codex = new Codex({
  ...(apiKey ? { apiKey } : {}),
  ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
  config: modelConfig,
  ...(configOverrides ? { configOverrides } : {}),
});
let e2bApiKey = process.env.E2B_API_KEY;
if (!e2bApiKey && process.env.E2B_ENABLED !== 'false') {
  try { e2bApiKey = (await readFile(process.env.E2B_API_KEY_FILE || resolve(homedir(), '.data/e2b/config/api-key'), 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const e2bEnabled = process.env.E2B_ENABLED !== 'false' && Boolean(e2bApiKey && apiKey);
const e2bTemplate = process.env.E2B_TEMPLATE || 'base';
const e2bWorkingDirectory = process.env.E2B_WORKSPACE || '/home/user/workspace';
const executionMode = process.env.CODEX_EXECUTION_MODE || (e2bEnabled ? 'e2b' : 'local');
if (!['local', 'e2b'].includes(executionMode)) throw new Error('CODEX_EXECUTION_MODE must be local or e2b');
if (executionMode === 'e2b' && !e2bEnabled) throw new Error('E2B needs its API key and a CODEX_API_KEY / OPENAI_API_KEY for the remote Codex');
const localWorkingDirectory = resolve(process.env.CODEX_WORKSPACE || process.cwd());
const defaults: Settings = {
  executionMode: executionMode as Settings['executionMode'],
  workingDirectory: executionMode === 'e2b' ? e2bWorkingDirectory : localWorkingDirectory,
  model: process.env.CODEX_MODEL || DEFAULT_MODEL,
  modelReasoningEffort: 'medium', sandboxMode: executionMode === 'e2b' ? 'danger-full-access' : 'workspace-write',
  webSearchMode: 'cached', networkAccessEnabled: executionMode === 'e2b',
};
const e2bConnection = process.env.E2B_ENABLED !== 'false' && e2bApiKey ? {
    apiKey: e2bApiKey!, apiUrl: process.env.E2B_API_URL || 'http://127.0.0.1:13000',
    sandboxUrl: process.env.E2B_SANDBOX_URL || 'http://127.0.0.1:13002',
    domain: process.env.E2B_DOMAIN || 'localhost', debug: false, requestTimeoutMs: 60_000,
  } : undefined;
const improvements = new ImprovementStore(process.env.IMPROVEMENTS_DB_PATH ? resolve(process.env.IMPROVEMENTS_DB_PATH) : undefined);
async function submitImprovement(context: Omit<ImprovementContext, 'projectName'>, input: unknown, requestId: string): Promise<ImprovementReceipt> {
  const session = manager.get(context.sessionId);
  if (!session.turns.some(turn => turn.id === context.turnId) || (session.projectId ?? null) !== context.projectId) throw new Error('建议来源会话不匹配');
  const project = session.projectId ? manager.getProject(session.projectId) : null;
  return improvements.submit({ ...context, sessionTitle: session.title, projectName: project?.name ?? null }, input, requestId);
}
const connections = new ConnectionStore();
const runtimeLog = new RuntimeLog({ secrets: [apiKey, e2bApiKey].filter((value): value is string => Boolean(value)) });
const localE2b = e2bConnection && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(e2bConnection.apiUrl!).hostname);
const archives = localE2b && process.env.E2B_ARCHIVE_ENABLED !== 'false' ? new LocalSnapshotArchive({
  storage: new LocalSandboxArchiveStorage(resolve(process.env.E2B_ARCHIVE_DIR || 'data/sandbox-archives')),
  e2bDirectory: resolve(process.env.E2B_LOCAL_DATA_DIR || resolve(homedir(), '.data/e2b')),
  inspectBinary: resolve(process.env.E2B_INSPECT_BINARY || 'data/tools/inspect-build'),
}) : undefined;
const e2b = e2bEnabled ? new E2BCodexRuntime({
  connections,
  archives,
  submitImprovement,
  logger: runtimeLog,
  connection: e2bConnection!,
  template: e2bTemplate, apiKey: apiKey!,
  baseUrl: process.env.OPENAI_BASE_URL, modelConfig, configOverrides,
}) : undefined;
const manager = new SessionManager(codex, resolve(process.env.CODEX_WEB_DATA_DIR || '.codex-web'), defaults, e2b, e2bWorkingDirectory, runtimeLog);
await manager.init();
const config: AppConfig = {
  defaults, sdkVersion: '0.153.4', auth: apiKey ? 'api-key' : 'local-codex',
  localWorkingDirectory, e2b: { enabled: e2bEnabled, template: e2bTemplate, workingDirectory: e2bWorkingDirectory },
  approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false, sandboxPreviews: true },
};
const templates = new TemplateManager({
  initialDefault: e2bTemplate,
  enabled: Boolean(e2bConnection),
  secrets: [e2bApiKey, apiKey].filter((value): value is string => Boolean(value)),
  onActivate: reference => {
    e2b?.setDefaultTemplate(reference);
    if (config.e2b) config.e2b.template = reference;
  },
});
await templates.init();
const activeTemplate = (await templates.list()).defaultTemplate;
e2b?.setDefaultTemplate(activeTemplate);
if (config.e2b) config.e2b.template = activeTemplate;
const app = createApp(manager, config, [`localhost:${port}`, `127.0.0.1:${port}`], undefined, new E2BSandboxInventory(e2bConnection), undefined, templates, connections, improvements);
let vite: import('vite').ViteDevServer | undefined;
if (process.env.NODE_ENV === 'production') {
  installProductionStatic(app);
} else {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
}
const listener = getRequestListener(app.fetch);
const server = createServer((request, response) => {
  if (request.url?.startsWith('/api/') || !vite) void listener(request, response);
  else vite.middlewares(request, response);
});
server.listen(port, '127.0.0.1', () => {
  void runtimeLog.write({ event: 'service.started', port, model: defaults.model, executionMode, httpDiagnostics: Boolean(e2bEnabled && process.env.OPENAI_BASE_URL) });
  console.log(`Codex Web ready at http://localhost:${port}`);
  console.log(`Workspace: ${defaults.workingDirectory}`);
  console.log(`Execution: ${defaults.executionMode}${e2bEnabled ? ` · E2B template ${activeTemplate}` : ''}`);
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await templates.close();
  await manager.close();
  improvements.close();
  await runtimeLog.write({ event: 'service.stopped' });
  await runtimeLog.flush();
  await vite?.close();
  server.closeAllConnections();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
