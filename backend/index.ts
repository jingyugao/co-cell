import { ImageCatalog } from './images/service.js';
import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Codex, appServerArgs } from '../packages/agentcore/src/index.mjs';
import { getRequestListener } from '@hono/node-server';
import { SandboxManager } from '@co-cell/sandbox';
import { CellboxSandboxProvider } from '../packages/sandbox/src/providers/cellbox/index.js';
import { CellboxRuntimeIntegration, CELLBOX_PRODUCT_PATHS } from './sandboxes/cellbox-runtime.js';
import { CellboxSandboxInventory } from './sandboxes/cellbox-inventory.js';
import type { AppConfig, Settings } from '../protocol/types.js';
import { DEFAULT_MODEL } from '../util/models.js';
import { NotificationStore } from './notifications/store.js';
import { createApp } from './app.js';
import { SessionManager } from './sessions/manager.js';
import { ContainerCodexRuntime } from './execution/container-runtime.js';
import { ProjectSandboxes } from './sandboxes/project-sandboxes.js';
import { RuntimeLog } from './infra/diagnostics/runtime-log.js';
import { installProductionStatic } from './infra/http/static-files.js';
import { modelProxyKind } from './execution/model-proxy.js';
import { createWebStateStore } from './infra/storage/web-state.js';
import { SecretCrypto } from './secrets/crypto.js';
import { SecretService } from './secrets/service.js';

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const mysqlUrl = process.env.MYSQL_URL?.trim() ?? '';
const webState = createWebStateStore(mysqlUrl);
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

const runtimeLog = new RuntimeLog({ ...(process.env.RUNTIME_LOG_DIRECTORY ? { directory: resolve(process.env.RUNTIME_LOG_DIRECTORY) } : {}),
  secrets: [apiKey,process.env.CELLBOX_API_TOKEN,process.env.COCELL_ACCESS_TOKEN].filter((value): value is string => Boolean(value)) });
const secretCrypto = new SecretCrypto(process.env.COCELL_SECRET_MASTER_KEY ?? '');
const toolBrokerUrl = process.env.COCELL_TOOL_BROKER_URL;
if (!toolBrokerUrl) throw new Error('COCELL_TOOL_BROKER_URL must be an HTTP(S) origin reachable from Sandboxes');
const brokerOrigin = new URL(toolBrokerUrl);
if (!['http:', 'https:'].includes(brokerOrigin.protocol) || brokerOrigin.username || brokerOrigin.password || brokerOrigin.search || brokerOrigin.hash || brokerOrigin.pathname !== '/') throw new Error('COCELL_TOOL_BROKER_URL must be an HTTP(S) origin');
if (process.env.SANDBOX_PROVIDER && process.env.SANDBOX_PROVIDER !== 'cellbox') {
  throw new Error('SANDBOX_PROVIDER=docker is unsupported; CoCell requires Cellbox Kubernetes');
}
const cellboxKind=process.env.CELLBOX_KIND??'k8s-resumable';
if(cellboxKind!=='k8s-resumable')throw new Error('This CoCell Cellbox adapter requires CELLBOX_KIND=k8s-resumable');
const cocellPublicUrl = process.env.COCELL_PUBLIC_URL || `http://127.0.0.1:${port}`;
const appServerArguments=appServerArgs(modelConfig, configOverrides).slice(1);
for(const name of ['CELLBOX_API_URL','CELLBOX_API_TOKEN','CELLBOX_PROFILE','COCELL_ACCESS_TOKEN'])if(!process.env[name])throw new Error(name+' is required for Cellbox Kubernetes mode');
if(process.env.COCELL_ACCESS_TOKEN!.length<32)throw new Error('COCELL_ACCESS_TOKEN must contain at least 32 bytes');
const cellboxProvider=new CellboxSandboxProvider({baseUrl:process.env.CELLBOX_API_URL!,token:process.env.CELLBOX_API_TOKEN!,profileId:process.env.CELLBOX_PROFILE!,kind:'k8s-resumable',workspace:'/home/agent/workspace',stateDirectory:resolve('data/cellbox-operations')});
await cellboxProvider.initialize();
let manager: SessionManager;
const secrets = new SecretService(webState.secretRepository, secretCrypto, id => cellboxProvider.client.getBox(id), (projectId, boxId) => {
  const project = manager?.listProjects().find(project => project.id === projectId);
  return Boolean(project && project.status !== 'archived' && project.sandbox?.id === boxId);
});
const cellboxRuntime=new CellboxRuntimeIntegration({provider:cellboxProvider,profileId:process.env.CELLBOX_PROFILE!,appServerArgs:appServerArguments,
  env:{...(apiKey?{CODEX_API_KEY:apiKey}:{}),...(process.env.OPENAI_BASE_URL?{OPENAI_BASE_URL:process.env.OPENAI_BASE_URL}:{})},
  secrets, toolBrokerUrl,
  onRenewalFailure:error=>{void runtimeLog.write({event:'sandbox.cellbox_renewal_failed',error});}});
const provider = cellboxProvider;
const inventory = new CellboxSandboxInventory(cellboxProvider);
const sandboxImage = process.env.CELLBOX_PROFILE!;
const sandboxWorkingDirectory = '/home/agent/workspace';
const sandboxImageIdentity = await cellboxProvider.currentImageIdentity();
const appServer = (id: string) => cellboxRuntime.appServer(id);
const localWorkingDirectory=resolve(process.env.CODEX_WORKSPACE||process.cwd());
const defaults:Settings={executionMode:'sandbox',workingDirectory:sandboxWorkingDirectory,model:process.env.CODEX_MODEL||DEFAULT_MODEL,modelReasoningEffort:'medium',sandboxMode:'danger-full-access',webSearchMode:'cached',networkAccessEnabled:true};
const autoCheckpointAfterMs = Number(process.env.SANDBOX_AUTO_CHECKPOINT_AFTER_MS ?? 60 * 60 * 1000);
if (!Number.isFinite(autoCheckpointAfterMs) || autoCheckpointAfterMs <= 0) throw new Error('SANDBOX_AUTO_CHECKPOINT_AFTER_MS must be positive');
const sandboxManager = new SandboxManager({ provider, logger: runtimeLog, policy: { autoCheckpointAfterMs }, lifecycle: cellboxRuntime.lifecycle });
const projectSandboxes = new ProjectSandboxes(sandboxManager, sandboxImage);
const notifications = new NotificationStore(process.env.NOTIFICATIONS_DATA_PATH ? resolve(process.env.NOTIFICATIONS_DATA_PATH) : undefined);
await notifications.init();
const runtime = new ContainerCodexRuntime({ sandboxes: projectSandboxes, provider, apiKey: apiKey || '',
  logger: runtimeLog, baseUrl: process.env.OPENAI_BASE_URL, modelConfig, configOverrides,
  ...(process.env.SHARED_DATA_DIRECTORY ? { sharedDataDirectory: pathToFileURL(`${resolve(process.env.SHARED_DATA_DIRECTORY)}/`) } : {}),
  appServer, paths:CELLBOX_PRODUCT_PATHS, prepareRemote:(handle,target,signal)=>cellboxRuntime.prepare(handle,target,signal),
  acquireRemoteUsage:id=>cellboxRuntime.acquireUsage(id), remoteArchives:cellboxRuntime.remoteArchives,
  serviceAccess:(id:string,port:number)=>cellboxProvider.getServiceAccess(id,port,'cocell-preview',120) });
const webDataDirectory = resolve(process.env.CODEX_WEB_DATA_DIR || 'data/web-state');
const webImagesDirectory = resolve(process.env.CODEX_WEB_IMAGES_DIR || 'data/images');
const archivedReclaimAfterMs = Number(process.env.SANDBOX_ARCHIVED_RECLAIM_AFTER_MS ?? 24 * 60 * 60 * 1000);
const lifecycleScanIntervalMs = process.env.SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS === undefined ? undefined : Number(process.env.SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS);
if (!Number.isFinite(archivedReclaimAfterMs) || archivedReclaimAfterMs < 0) throw new Error('SANDBOX_ARCHIVED_RECLAIM_AFTER_MS must be non-negative');
manager = new SessionManager(codex, webDataDirectory, defaults, webState, runtime, sandboxWorkingDirectory, runtimeLog,
  webImagesDirectory, {
    archivedReclaimAfterMs,
    ...(lifecycleScanIntervalMs === undefined ? {} : { scanIntervalMs: lifecycleScanIntervalMs }),
  }, notifications);
// Project tables must exist before the Secret schema's foreign keys are created.
await webState.init();
await secrets.init();
await manager.init();
// Paused instances are configured on resume. Running instances survive a web
// service restart; compare their durable acknowledgements before writing slots.
for (const project of manager.listProjects()) {
  if (project.status === 'archived' || !project.sandbox) continue;
  try { await cellboxRuntime.reconcile({ id: project.id, projectId: project.id, updatedAt: project.updatedAt,
    settings: { workingDirectory: project.sandbox.workingDirectory }, sandbox: project.sandbox }); }
  catch (error) { runtimeLog.write({ event: 'sandbox.runtime_config_reconcile_failed', projectId: project.id, error }); }
}
const imageCatalog = new ImageCatalog(webState, cellboxProvider.client, process.env.CELLBOX_PROFILE!, undefined, () => manager.listProjects());
await imageCatalog.init();
manager.setImageCatalog(imageCatalog);
const config: AppConfig = { sandbox: { provider:'cellbox',kind:'k8s-resumable',enabled: true, image: sandboxImage, workingDirectory: sandboxWorkingDirectory,
  ...(sandboxImageIdentity ? { imageIdentity: sandboxImageIdentity } : {}),
  archivedReclaimAfterMs }, defaults, codexVersion: '0.153.4', auth: apiKey ? 'api-key' : 'local-codex',
  localWorkingDirectory, approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false, sandboxPreviews: true } };
const publicUrl=cocellPublicUrl;
const previewSubdomains=process.env.COCELL_PREVIEW_SUBDOMAINS==='1';
const publicHost=new URL(publicUrl).host;
const additionalAllowedHosts = (process.env.ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const app = createApp(manager, config, [...new Set([`localhost:${port}`, `127.0.0.1:${port}`, publicHost,...additionalAllowedHosts])],
  inventory, undefined, undefined, notifications, { token:process.env.COCELL_ACCESS_TOKEN!,publicUrl,previewSubdomains,provider:cellboxProvider,projects:()=>manager.listProjects() }, imageCatalog, secrets);
let vite: import('vite').ViteDevServer | undefined;
if (process.env.NODE_ENV === 'production') installProductionStatic(app);
else { const { createServer: createViteServer } = await import('vite'); vite = await createViteServer({ server: { middlewareMode: true, ws:false, hmr:false }, appType: 'spa' }); }
const listener = getRequestListener(app.fetch);
const { isAuthenticatedDevRequest } = await import('./access/operator.js');
const server = createServer((request, response) => {
  if (!vite || /^\/(?:api|mcp|auth)(?:\/|\?|$)/.test(request.url??'') ||
      !isAuthenticatedDevRequest(request,publicHost,process.env.COCELL_ACCESS_TOKEN!)) {
    void listener(request,response);
  } else vite.middlewares(request,response);
});
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  void runtimeLog.write({ event: 'service.started', port, model: defaults.model, executionMode: 'sandbox' });
  console.log(`Codex Web ready at http://localhost:${port}`); console.log(`Sandbox: Cellbox image ${sandboxImage} · workspace ${sandboxWorkingDirectory}`);
});
let shuttingDown = false;
// Periodic sandbox archive for active projects — every 30 minutes
const archiveInterval = setInterval(() => { void manager.scheduledArchive().catch(() => {}); }, 60 * 1000);
archiveInterval.unref();
async function shutdown() { if (shuttingDown) return; shuttingDown = true; server.close(); await manager.close(); await cellboxRuntime.close(); await sandboxManager.close();
  clearInterval(archiveInterval);
  await runtimeLog.write({ event: 'service.stopped' }); await runtimeLog.flush(); await vite?.close(); server.closeAllConnections(); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
