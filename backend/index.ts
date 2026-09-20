import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Codex, appServerArgs } from '../packages/agentcore/src/index.mjs';
import { getRequestListener } from '@hono/node-server';
import { DockerSandboxImageManager, GvisorHelperClient, GvisorSandboxProvider, SandboxManager, type SandboxProvider } from '@swarm-hive/sandbox';
import type { AppConfig, Settings } from '../protocol/types.js';
import type { ImprovementContext, ImprovementReceipt } from '../protocol/improvement-types.js';
import { DEFAULT_MODEL } from '../util/models.js';
import { ImprovementStore } from './improvements/store.js';
import { NotificationStore } from './notifications/store.js';
import { createApp } from './app.js';
import { SessionManager } from './sessions/manager.js';
import { ContainerCodexRuntime } from './execution/container-runtime.js';
import { ArchiveStore } from './archives/store.js';
import { ArchiveManager } from './archives/manager.js';
import { ProjectSandboxes } from './sandboxes/project-sandboxes.js';
import { DockerSandboxInventory } from './sandboxes/inventory.js';
import { RuntimeLog } from './infra/diagnostics/runtime-log.js';
import { installProductionStatic } from './infra/http/static-files.js';
import { modelProxyKind } from './execution/model-proxy.js';
import { createWebStateStore } from './infra/storage/web-state.js';
import { DockerSandboxClient } from '../packages/docker-sandbox/src/index.js';
import { dockerSandboxProvider } from './sandboxes/docker-provider.js';
import { ConnectionStore } from './connections/store.js';
import { ApprovalMcpService } from './approvals/mcp.js';

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
const runtimeLog = new RuntimeLog({ ...(process.env.RUNTIME_LOG_DIRECTORY ? { directory: resolve(process.env.RUNTIME_LOG_DIRECTORY) } : {}),
  secrets: [apiKey].filter((value): value is string => Boolean(value)) });
// Tests and parallel local instances can isolate their capability token and
// credential runtime files without touching the primary Web service's state.
const connections = new ConnectionStore(process.env.CONNECTIONS_DATA_DIR ? { directory: resolve(process.env.CONNECTIONS_DATA_DIR) } : undefined);
await mkdir(connections.sandboxRuntimeDirectory(), { recursive: true, mode: 0o700 });
const sandboxAppServerToken = resolve(connections.sandboxRuntimeDirectory(), 'app-server-token');
try { await access(sandboxAppServerToken); } catch {
  await writeFile(sandboxAppServerToken, randomBytes(32).toString('base64url'), { mode: 0o600 });
}
await chmod(sandboxAppServerToken, 0o644);
const approvalMcpTokenPath = resolve(connections.sandboxRuntimeDirectory(), 'approval-mcp-token');
try { await access(approvalMcpTokenPath); } catch {
  await writeFile(approvalMcpTokenPath, randomBytes(32).toString('base64url'), { mode: 0o600 });
}
await chmod(approvalMcpTokenPath, 0o600);
const approvalMcpToken = process.env.SANDBOX_APPROVAL_MCP_TOKEN || (await readFile(approvalMcpTokenPath, 'utf8')).trim();
const approvalMcpUrl = process.env.SANDBOX_APPROVAL_MCP_URL || `http://swarm-hive:${port}/mcp/approvals`;
const approvalMcpOverrides = [
  `mcp_servers.swarm_approvals.url=${JSON.stringify(approvalMcpUrl)}`,
  `mcp_servers.swarm_approvals.http_headers.Authorization=${JSON.stringify(`Bearer ${approvalMcpToken}`)}`,
  'mcp_servers.swarm_approvals.enabled=true',
  'mcp_servers.swarm_approvals.required=true',
  'mcp_servers.swarm_approvals.enabled_tools=["request_user_approval"]',
  'mcp_servers.swarm_approvals.omit_tools_from=["deferred"]',
  'mcp_servers.swarm_approvals.startup_timeout_sec=10',
  'mcp_servers.swarm_approvals.tool_timeout_sec=1900',
];
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
    CODEX_APP_SERVER_ARGS: JSON.stringify(appServerArgs(modelConfig, [...(configOverrides ?? []), ...approvalMcpOverrides]).slice(1)),
  });
const sandboxImageIdentity = await dockerClient.imageIdentity().catch(error => {
  console.warn(`Unable to inspect Sandbox image identity: ${error instanceof Error ? error.message : String(error)}`);
  return undefined;
});
const sandboxProviderKind = process.env.SANDBOX_PROVIDER ?? 'docker';
if (sandboxProviderKind !== 'docker' && sandboxProviderKind !== 'gvisor') throw new Error('SANDBOX_PROVIDER must be docker or gvisor');
const gvisorBundleRoot = resolve(process.env.GVISOR_BUNDLE_ROOT ?? '/var/lib/swarm-hive/gvisor/bundles');
const appServerCommand = "const {spawn}=require('node:child_process'); spawn('/usr/local/bin/sandbox-proxy',[],{stdio:'inherit',detached:true}).unref(); const extra=JSON.parse(process.env.CODEX_APP_SERVER_ARGS||'[]'); const child=spawn('codex',['app-server',...extra,'--listen',`ws://0.0.0.0:${process.env.CODEX_APP_SERVER_PORT}`, '--ws-auth','capability-token','--ws-token-file','/home/user/.codex-web/app-server-token'],{stdio:'inherit'}); child.on('exit',(code,signal)=>process.exit(code??(signal?1:0))); process.on('SIGTERM',()=>child.kill('SIGTERM')); process.on('SIGINT',()=>child.kill('SIGINT')); ";
let provider: SandboxProvider;
let appServer: (sandboxId: string) => Promise<{ url: string; token: string }>;
if (sandboxProviderKind === 'gvisor') {
  const token = (await readFile(sandboxAppServerToken, 'utf8')).trim();
  const gvisor = new GvisorSandboxProvider(new DockerSandboxImageManager(dirname(gvisorBundleRoot), process.env.DOCKER_BIN || 'docker'),
    new GvisorHelperClient(process.env.GVISOR_HELPER_URL ?? (process.env.DOCKER_HOST ? 'http://host.docker.internal:8090' : 'http://127.0.0.1:8090')), sandboxImage, {
      bundleRoot: gvisorBundleRoot, workingDirectory: sandboxWorkingDirectory,
      process: { args: ['node', '-e', appServerCommand], cwd: sandboxWorkingDirectory, uid: 1000, gid: 1000, env: {
        HOME: '/home/user', CODEX_HOME: '/home/user/.codex', GLAB_CONFIG_DIR: '/home/user/.codex-web/credentials/current/glab',
        MYSQL_TEST_LOGIN_FILE: '/home/user/.codex-web/credentials/current/.mylogin.cnf', KUBECONFIG: '/home/user/.codex-web/credentials/current/kubernetes/config.json',
        LARKSUITE_CLI_CONFIG_DIR: '/home/user/.codex-web/credentials/current/lark-config', LARKSUITE_CLI_DATA_DIR: '/home/user/.codex-web/credentials/current/lark-data',
        LARKSUITE_CLI_DEFAULT_AS: 'bot', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0',
        MISE_DATA_DIR: '/home/user/.local/share/mise', MISE_CONFIG_DIR: '/home/user/.config/mise', MISE_STATE_DIR: '/home/user/.local/state/mise', MISE_TRUSTED_CONFIG_PATHS: sandboxWorkingDirectory,
        PATH: '/home/user/.local/share/mise/shims:/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin',
        ...(apiKey ? { CODEX_API_KEY: apiKey } : {}), ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
        CODEX_APP_SERVER_ARGS: JSON.stringify(appServerArgs(modelConfig, [...(configOverrides ?? []), ...approvalMcpOverrides]).slice(1)),
      } },
      mounts: [
        { source: process.env.GVISOR_RESOLV_CONF ?? '/etc/resolv.conf', destination: '/etc/resolv.conf' },
        { source: sandboxCredentialsHostDirectory, destination: '/home/user/.codex-web/credentials/current', readonly: false },
        { source: sandboxAppServerTokenHostPath, destination: '/home/user/.codex-web/app-server-token' },
        { source: sharedAgentsHostPath, destination: '/home/user/.codex/AGENTS.md' },
      ], networkNamespaceRoot: process.env.GVISOR_NETNS_ROOT ?? '/var/run/netns',
      appServer: { host: process.env.GVISOR_APP_SERVER_HOST ?? (process.env.DOCKER_HOST ? 'host.docker.internal' : '127.0.0.1'), token },
    });
  provider = gvisor;
  appServer = id => gvisor.appServer(id);
} else {
  provider = dockerSandboxProvider(dockerClient);
  appServer = id => dockerClient.appServer(id);
}
const autoCheckpointAfterMs = Number(process.env.SANDBOX_AUTO_CHECKPOINT_AFTER_MS ?? 60 * 60 * 1000);
if (!Number.isFinite(autoCheckpointAfterMs) || autoCheckpointAfterMs <= 0) throw new Error('SANDBOX_AUTO_CHECKPOINT_AFTER_MS must be positive');
const sandboxManager = new SandboxManager({ provider, logger: runtimeLog, policy: { autoCheckpointAfterMs } });
const projectSandboxes = new ProjectSandboxes(sandboxManager, sandboxImage);
const improvements = new ImprovementStore(process.env.IMPROVEMENTS_DB_PATH ? resolve(process.env.IMPROVEMENTS_DB_PATH) : undefined);
const notifications = new NotificationStore(process.env.NOTIFICATIONS_DATA_PATH ? resolve(process.env.NOTIFICATIONS_DATA_PATH) : undefined);
await notifications.init();
let manager: SessionManager;
const approvalMcp = new ApprovalMcpService(approvalMcpToken, (context, input, requestId, signal) =>
  manager.requestApproval(context.sessionId, context.turnId, context.projectId, requestId, input, signal));
async function submitImprovement(context: Omit<ImprovementContext, 'projectName'>, input: unknown, requestId: string): Promise<ImprovementReceipt> {
  const session = manager.get(context.sessionId);
  if (!session.turns.some(turn => turn.id === context.turnId) || (session.projectId ?? null) !== context.projectId) throw new Error('建议来源会话不匹配');
  const project = session.projectId ? manager.getProject(session.projectId) : null;
  return improvements.submit({ ...context, sessionTitle: session.title, projectName: project?.name ?? null }, input, requestId);
}
const runtime = new ContainerCodexRuntime({ sandboxes: projectSandboxes, provider, connections, apiKey: apiKey || '', submitImprovement,
  logger: runtimeLog, baseUrl: process.env.OPENAI_BASE_URL, proxyKind, modelConfig, configOverrides,
  ...(process.env.SHARED_DATA_DIRECTORY ? { sharedDataDirectory: pathToFileURL(`${resolve(process.env.SHARED_DATA_DIRECTORY)}/`) } : {}),
  appServer });
const webDataDirectory = resolve(process.env.CODEX_WEB_DATA_DIR || 'data/web-state');
const webImagesDirectory = resolve(process.env.CODEX_WEB_IMAGES_DIR || 'data/images');
const archivedReclaimAfterMs = Number(process.env.SANDBOX_ARCHIVED_RECLAIM_AFTER_MS ?? 24 * 60 * 60 * 1000);
const lifecycleScanIntervalMs = process.env.SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS === undefined ? undefined : Number(process.env.SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS);
if (!Number.isFinite(archivedReclaimAfterMs) || archivedReclaimAfterMs < 0) throw new Error('SANDBOX_ARCHIVED_RECLAIM_AFTER_MS must be non-negative');
const archiveDataDir = resolve('data/sandbox-data-archives');
const archiveStore = process.env.MYSQL_URL ? new ArchiveStore(process.env.MYSQL_URL) : undefined;
if (archiveStore) await archiveStore.init();
const archiveMgr = archiveStore ? new ArchiveManager(archiveStore, archiveDataDir) : undefined;
manager = new SessionManager(codex, webDataDirectory, defaults, runtime, sandboxWorkingDirectory, runtimeLog,
  createWebStateStore(webDataDirectory, process.env.MYSQL_URL), webImagesDirectory, {
    archivedReclaimAfterMs,
    ...(lifecycleScanIntervalMs === undefined ? {} : { scanIntervalMs: lifecycleScanIntervalMs }),
  }, notifications, archiveMgr);
await manager.init();
const config: AppConfig = { sandbox: { enabled: true, image: sandboxImage,
  ...(sandboxImageIdentity ? { imageIdentity: sandboxImageIdentity } : {}), workingDirectory: sandboxWorkingDirectory,
  archivedReclaimAfterMs }, defaults, codexVersion: '0.153.4', auth: apiKey ? 'api-key' : 'local-codex',
  localWorkingDirectory, approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false, sandboxPreviews: true } };
const additionalAllowedHosts = (process.env.ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const app = createApp(manager, config, [...new Set([`localhost:${port}`, `127.0.0.1:${port}`, ...additionalAllowedHosts])],
  new DockerSandboxInventory(dockerClient), undefined, connections, improvements, approvalMcp, notifications);
let vite: import('vite').ViteDevServer | undefined;
if (process.env.NODE_ENV === 'production') installProductionStatic(app);
else { const { createServer: createViteServer } = await import('vite'); vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' }); }
const listener = getRequestListener(app.fetch);
const server = createServer((request, response) => { if (request.url?.startsWith('/api/') || request.url?.startsWith('/mcp/') || !vite) void listener(request, response); else vite.middlewares(request, response); });
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  void runtimeLog.write({ event: 'service.started', port, model: defaults.model, executionMode: 'sandbox' });
  console.log(`Codex Web ready at http://localhost:${port}`); console.log(`Sandbox: ${sandboxProviderKind} image ${sandboxImage} · workspace ${sandboxWorkingDirectory}`);
});
let shuttingDown = false;
// Periodic sandbox archive for active projects — every 30 minutes
const archiveInterval = setInterval(() => { void manager.scheduledArchive().catch(() => {}); }, 60 * 1000);
archiveInterval.unref();
async function shutdown() { if (shuttingDown) return; shuttingDown = true; server.close(); await manager.close(); await sandboxManager.close();
  clearInterval(archiveInterval);
  improvements.close(); await runtimeLog.write({ event: 'service.stopped' }); await runtimeLog.flush(); await vite?.close(); server.closeAllConnections(); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
