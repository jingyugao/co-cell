import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Codex, appServerArgs } from '../packages/agentcore/src/index.mjs';
import { getRequestListener } from '@hono/node-server';
import { SandboxManager } from '@swarm-hive/sandbox';
import type { AppConfig, Settings } from '../protocol/types.js';
import type { ImprovementContext, ImprovementReceipt } from '../protocol/improvement-types.js';
import { DEFAULT_MODEL } from '../util/models.js';
import { ImprovementStore } from './improvements/store.js';
import { createApp } from './app.js';
import { SessionManager } from './sessions/manager.js';
import { ContainerCodexRuntime } from './execution/container-runtime.js';
import { ProjectSandboxes } from './sandboxes/project-sandboxes.js';
import { DockerSandboxInventory } from './sandboxes/inventory.js';
import { RuntimeLog } from './infra/diagnostics/runtime-log.js';
import { installProductionStatic } from './infra/http/static-files.js';
import { modelProxyKind } from './execution/model-proxy.js';
import { createWebStateStore } from './infra/storage/web-state.js';
import { DockerSandboxClient } from '../packages/docker-sandbox/src/index.js';
import { dockerSandboxProvider } from './sandboxes/docker-provider.js';
import { ConnectionStore } from './connections/store.js';

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
const proxyKind = modelProxyKind();
const sdkConfig = process.env.CODEX_CONFIG_JSON ? JSON.parse(process.env.CODEX_CONFIG_JSON) : {};
const proxyConfig = process.env.OPENAI_BASE_URL ? { model_provider: 'codex_web_proxy', model_providers: { codex_web_proxy: {
  name: 'Codex Web proxy', base_url: process.env.OPENAI_BASE_URL, wire_api: 'responses', supports_websockets: false,
  ...(apiKey ? { env_key: 'CODEX_API_KEY' } : { requires_openai_auth: true }),
  ...(proxyKind === 'cliproxyapi' || proxyKind === 'litellm' ? { request_max_retries: 0, stream_max_retries: 0 } : {}),
} } } : {};
const modelConfig = { ...proxyConfig, ...sdkConfig, model_providers: { ...proxyConfig.model_providers, ...sdkConfig.model_providers } };
const configOverrides = process.env.CODEX_CONFIG_OVERRIDES_JSON ? JSON.parse(process.env.CODEX_CONFIG_OVERRIDES_JSON) : undefined;
const codex = new Codex({ ...(apiKey ? { apiKey } : {}), ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
  config: modelConfig, ...(configOverrides ? { configOverrides } : {}) });

const sandboxImage = process.env.DOCKER_SANDBOX_IMAGE || 'swarm-hive-sandbox:latest';
const sandboxWorkingDirectory = process.env.SANDBOX_WORKSPACE || '/home/user/workspace';
const localWorkingDirectory = resolve(process.env.CODEX_WORKSPACE || process.cwd());
const defaults: Settings = { executionMode: 'sandbox', workingDirectory: sandboxWorkingDirectory,
  model: process.env.CODEX_MODEL || DEFAULT_MODEL, modelReasoningEffort: 'medium', sandboxMode: 'danger-full-access',
  webSearchMode: 'cached', networkAccessEnabled: true };
const runtimeLog = new RuntimeLog({ secrets: [apiKey].filter((value): value is string => Boolean(value)) });
const connections = new ConnectionStore();
await mkdir(connections.sandboxRuntimeDirectory(), { recursive: true, mode: 0o700 });
const sandboxAppServerToken = resolve(connections.sandboxRuntimeDirectory(), 'app-server-token');
try { await access(sandboxAppServerToken); } catch {
  await writeFile(sandboxAppServerToken, randomBytes(32).toString('base64url'), { mode: 0o600 });
}
await chmod(sandboxAppServerToken, 0o644);
// The Web container creates this through its /app/data bind mount. Docker
// commands, however, are evaluated by the host daemon and use the optional
// host path supplied by Compose.
const sandboxCredentialsDirectory = resolve(connections.sandboxDirectory());
await mkdir(sandboxCredentialsDirectory, { recursive: true, mode: 0o700 });
await chmod(sandboxCredentialsDirectory, 0o700);
const sandboxCredentialsHostDirectory = process.env.SANDBOX_CREDENTIALS_HOST_DIR || sandboxCredentialsDirectory;
const sandboxAppServerTokenHostPath = process.env.SANDBOX_APP_SERVER_TOKEN_HOST_PATH || sandboxAppServerToken;
const sharedAgentsPath = resolve('data/AGENTS.md');
const sharedAgentsHostPath = process.env.SANDBOX_SHARED_AGENTS_PATH || sharedAgentsPath;
// Global rules are non-secret and need to be readable by the Sandbox's user.
await chmod(sharedAgentsPath, 0o644);
const dockerClient = new DockerSandboxClient(sandboxImage, process.env.DOCKER_BIN || 'docker', process.env.DOCKER_SANDBOX_NETWORK || 'swarm-hive_default', sandboxCredentialsHostDirectory, sandboxAppServerTokenHostPath, sharedAgentsHostPath,
  process.env.SANDBOX_APP_SERVER_HOST, {
    ...(apiKey ? { CODEX_API_KEY: apiKey } : {}), ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
    CODEX_APP_SERVER_ARGS: JSON.stringify(appServerArgs(modelConfig, configOverrides).slice(1)),
  });
const sandboxImageIdentity = await dockerClient.imageIdentity().catch(error => {
  console.warn(`Unable to inspect Sandbox image identity: ${error instanceof Error ? error.message : String(error)}`);
  return undefined;
});
const provider = dockerSandboxProvider(dockerClient);
const sandboxManager = new SandboxManager({ provider, logger: runtimeLog });
const projectSandboxes = new ProjectSandboxes(sandboxManager, sandboxImage);
const improvements = new ImprovementStore(process.env.IMPROVEMENTS_DB_PATH ? resolve(process.env.IMPROVEMENTS_DB_PATH) : undefined);
let manager: SessionManager;
async function submitImprovement(context: Omit<ImprovementContext, 'projectName'>, input: unknown, requestId: string): Promise<ImprovementReceipt> {
  const session = manager.get(context.sessionId);
  if (!session.turns.some(turn => turn.id === context.turnId) || (session.projectId ?? null) !== context.projectId) throw new Error('建议来源会话不匹配');
  const project = session.projectId ? manager.getProject(session.projectId) : null;
  return improvements.submit({ ...context, sessionTitle: session.title, projectName: project?.name ?? null }, input, requestId);
}
const runtime = new ContainerCodexRuntime({ sandboxes: projectSandboxes, provider, connections, apiKey: apiKey || '', submitImprovement,
  logger: runtimeLog, baseUrl: process.env.OPENAI_BASE_URL, proxyKind, modelConfig, configOverrides,
  appServer: id => dockerClient.appServer(id) });
const webDataDirectory = resolve(process.env.CODEX_WEB_DATA_DIR || 'data/web-state');
const webImagesDirectory = resolve(process.env.CODEX_WEB_IMAGES_DIR || 'data/images');
const archivedReclaimAfterMs = Number(process.env.SANDBOX_ARCHIVED_RECLAIM_AFTER_MS ?? 24 * 60 * 60 * 1000);
const lifecycleScanIntervalMs = process.env.SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS === undefined ? undefined : Number(process.env.SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS);
if (!Number.isFinite(archivedReclaimAfterMs) || archivedReclaimAfterMs < 0) throw new Error('SANDBOX_ARCHIVED_RECLAIM_AFTER_MS must be non-negative');
manager = new SessionManager(codex, webDataDirectory, defaults, runtime, sandboxWorkingDirectory, runtimeLog,
  createWebStateStore(webDataDirectory, process.env.MYSQL_URL), webImagesDirectory, {
    archivedReclaimAfterMs,
    ...(lifecycleScanIntervalMs === undefined ? {} : { scanIntervalMs: lifecycleScanIntervalMs }),
  });
await manager.init();
const config: AppConfig = { sandbox: { enabled: true, image: sandboxImage,
  ...(sandboxImageIdentity ? { imageIdentity: sandboxImageIdentity } : {}), workingDirectory: sandboxWorkingDirectory,
  archivedReclaimAfterMs }, defaults, codexVersion: '0.153.4', auth: apiKey ? 'api-key' : 'local-codex',
  localWorkingDirectory, approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false, sandboxPreviews: true } };
const app = createApp(manager, config, [`localhost:${port}`, `127.0.0.1:${port}`],
  new DockerSandboxInventory(dockerClient), undefined, connections, improvements);
let vite: import('vite').ViteDevServer | undefined;
if (process.env.NODE_ENV === 'production') installProductionStatic(app);
else { const { createServer: createViteServer } = await import('vite'); vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' }); }
const listener = getRequestListener(app.fetch);
const server = createServer((request, response) => { if (request.url?.startsWith('/api/') || !vite) void listener(request, response); else vite.middlewares(request, response); });
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  void runtimeLog.write({ event: 'service.started', port, model: defaults.model, executionMode: 'sandbox' });
  console.log(`Codex Web ready at http://localhost:${port}`); console.log(`Sandbox: Docker image ${sandboxImage} · workspace ${sandboxWorkingDirectory}`);
});
let shuttingDown = false;
async function shutdown() { if (shuttingDown) return; shuttingDown = true; server.close(); await manager.close(); await sandboxManager.close();
  improvements.close(); await runtimeLog.write({ event: 'service.stopped' }); await runtimeLog.flush(); await vite?.close(); server.closeAllConnections(); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
