import { createPreviewProxy } from './projects/preview-proxy.js';
import { readSystemRequirementInfo } from './projects/requirements.js';
import { SystemTools } from './execution/system-tools.js';
import { ModelService } from './models/service.js';
import { DirectModelProvider } from './models/direct-provider.js';
import { initializeTracing } from './infra/diagnostics/tracing.js';
import { ImageCatalog } from './images/service.js';
import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Codex, appServerArgs } from '../packages/agentcore/src/index.mjs';
import { getRequestListener } from '@hono/node-server';
import { CellboxSandboxProvider } from '../packages/sandbox/src/providers/cellbox/index.js';
import { CellboxRuntimeIntegration, CELLBOX_PRODUCT_PATHS } from './sandboxes/cellbox-runtime.js';
import { CellboxSandboxInventory } from './sandboxes/cellbox-inventory.js';
import type { AppConfig, Settings } from '../protocol/types.js';
import { DEFAULT_MODEL, MODEL_OPTIONS } from '../util/models.js';
import { NotificationStore } from './notifications/store.js';
import { createApp } from './app.js';
import { SessionManager } from './sessions/manager.js';
import { ContainerCodexRuntime } from './execution/container-runtime.js';
import { AppServerReader } from './execution/app-server-reader.js';
import { createNativeRelay } from './execution/native-relay.js';
import { ProjectSandboxes } from './sandboxes/project-sandboxes.js';
import { RuntimeLog } from './infra/diagnostics/runtime-log.js';
import { installProductionStatic } from './infra/http/static-files.js';
import { modelProxyKind } from './execution/model-proxy.js';
import { createWebStateStore } from './infra/storage/web-state.js';
import { MySqlCoordinator } from './infra/storage/coordination.js';
import { SecretCrypto } from './secrets/crypto.js';
import { NativeSecretFiles } from './secrets/native-files.js';
import { SecretService } from './secrets/service.js';
import { DynamicTools } from './tools/service.js';
import { SharedFiles } from './shared-files/service.js';
import { publishSharedDirectory } from './shared-files/mount.js';
import { publishToolWrappers } from './shared-files/tool-wrappers.js';
import { loadSharedMountConfig } from './shared-files/config.js';

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const shutdownTracing = initializeTracing();
const mysqlUrl = process.env.MYSQL_URL?.trim() ?? '';
const multiApiFlag = process.env.COCELL_MULTI_API ?? '0';
if (multiApiFlag !== '0' && multiApiFlag !== '1') throw new Error('COCELL_MULTI_API must be 0 or 1');
const multiApi = multiApiFlag === '1';
const coordinator = multiApi ? new MySqlCoordinator(mysqlUrl) : undefined;
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
modelProxyKind();
const sdkConfig = process.env.CODEX_CONFIG_JSON ? JSON.parse(process.env.CODEX_CONFIG_JSON) : {};
const proxyConfig = process.env.OPENAI_BASE_URL ? { model_provider: 'codex_web_proxy', model_providers: { codex_web_proxy: {
  name: 'Codex Web proxy', base_url: process.env.OPENAI_BASE_URL, wire_api: 'responses', supports_websockets: false,
  ...(apiKey ? { env_key: 'CODEX_API_KEY' } : { requires_openai_auth: true }),
} } } : {};
const modelConfig = { ...proxyConfig, ...sdkConfig, model_providers: { ...proxyConfig.model_providers, ...sdkConfig.model_providers } };
const configOverrides = process.env.CODEX_CONFIG_OVERRIDES_JSON ? JSON.parse(process.env.CODEX_CONFIG_OVERRIDES_JSON) : undefined;
const codex = new Codex({ ...(apiKey ? { apiKey } : {}), ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
  config: modelConfig, ...(configOverrides ? { configOverrides } : {}) });

const runtimeLog = new RuntimeLog({ ...(process.env.RUNTIME_LOG_DIRECTORY ? { directory: resolve(process.env.RUNTIME_LOG_DIRECTORY) } : {}),
  secrets: [apiKey,process.env.COCELL_ACCESS_TOKEN].filter((value): value is string => Boolean(value)) });
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
// Sandboxes connect directly to the configured model channel, including its key.
const appServerArguments=appServerArgs(modelConfig, configOverrides).slice(1);
const appServerEnv = {...(apiKey ? {CODEX_API_KEY:apiKey} : {}),
  ...(process.env.CODEX_MODEL_METADATA_JSON ? { CODEX_MODEL_METADATA_JSON: process.env.CODEX_MODEL_METADATA_JSON } : {})};
const sharedDirectory = await loadSharedMountConfig();
if (!sharedDirectory) throw new Error('CoCell tool wrappers require the shared persistent directory');
const sharedDataRoot = resolve(sharedDirectory ? '/app/shared' : (process.env.SHARED_DATA_DIRECTORY || 'data'));
const webState = createWebStateStore(mysqlUrl, new NativeSecretFiles(resolve(sharedDataRoot, 'runtime/debug-homes'), secretCrypto));
if (sharedDirectory) {
  const publish = async () => {
    await publishSharedDirectory(sharedDataRoot, resolve('data'), { version: 1, appServerArgs: appServerArguments, env: appServerEnv });
    await publishToolWrappers(sharedDataRoot);
  };
  if (coordinator) await coordinator.run('cocell-shared-startup-config', publish);
  else await publish();
}
for(const name of ['CELLBOX_API_URL','CELLBOX_PROFILE','COCELL_ACCESS_TOKEN'])if(!process.env[name])throw new Error(name+' is required for Cellbox Kubernetes mode');
if(process.env.COCELL_ACCESS_TOKEN!.length<32)throw new Error('COCELL_ACCESS_TOKEN must contain at least 32 bytes');
const cellboxProvider=new CellboxSandboxProvider({baseUrl:process.env.CELLBOX_API_URL!,clientId:process.env.CELLBOX_CLIENT_ID,profileId:process.env.CELLBOX_PROFILE!,kind:'k8s-resumable',workspace:'/home/agent/workspace',templateId:process.env.CELLBOX_TEMPLATE_ID,revisionId:process.env.CELLBOX_REVISION_ID});
await cellboxProvider.initialize();
let manager: SessionManager;
let closeNativeSandboxConnections = async (_id: string): Promise<void> => {};
const tools = new DynamicTools(webState.toolRepository, sharedDataRoot, coordinator);
const secrets = new SecretService(webState.secretRepository, secretCrypto, tools);
if (sharedDirectory) await secrets.mountHomes(sharedDataRoot);
const appServerReader: AppServerReader = new AppServerReader(id => cellboxRuntime.appServer(id),
  error => { void runtimeLog.write({ event: 'sandbox.access_release_failed', error }); }, multiApi ? 0 : undefined);
const cellboxRuntime=new CellboxRuntimeIntegration({provider:cellboxProvider,profileId:process.env.CELLBOX_PROFILE!,appServerArgs:appServerArguments,
  extensions: [{ name: 'native-app-server-connections', pre: async context => {
    if (context.sandboxId && ['pause', 'checkpoint', 'destroy'].includes(context.action))
      await closeNativeSandboxConnections(context.sandboxId);
  } }, appServerReader.extension],
  env:appServerEnv, sharedDirectory, ...(sharedDirectory ? { sharedDataRoot } : {}),
  secrets, toolBrokerUrl, logger: runtimeLog,
});
const provider = cellboxProvider;
const inventory = new CellboxSandboxInventory(cellboxProvider);
const sandboxImage = process.env.CELLBOX_PROFILE!;
const sandboxWorkingDirectory = '/home/agent/workspace';
const sandboxImageIdentity = await cellboxProvider.currentImageIdentity();
const appServer = (id: string) => cellboxRuntime.appServer(id);
const localWorkingDirectory=resolve(process.env.CODEX_WORKSPACE||process.cwd());
const defaults:Settings={executionMode:'sandbox',workingDirectory:sandboxWorkingDirectory,model:process.env.CODEX_MODEL||DEFAULT_MODEL,modelReasoningEffort:'medium',sandboxMode:'danger-full-access',webSearchMode:'cached',networkAccessEnabled:true};
let availableModels = [...MODEL_OPTIONS];
if (process.env.OPENAI_BASE_URL) {
  try {
    const modelsUrl = new URL('models', `${process.env.OPENAI_BASE_URL.replace(/\/+$/, '')}/`);
    const response = await fetch(modelsUrl, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const body = await response.json() as { data?: Array<{ id?: unknown }> };
      const discovered = (body.data ?? []).map(item => typeof item.id === 'string' ? item.id.trim() : '').filter(Boolean);
      if (discovered.length) availableModels = [...new Set(discovered)];
    } else runtimeLog.write({ event: 'models.discovery_failed', status: response.status });
  } catch (error) { runtimeLog.write({ event: 'models.discovery_failed', error }); }
}
const models = new ModelService(webState.modelRepository, secretCrypto, { endpoint: process.env.OPENAI_BASE_URL, apiKey, model: defaults.model, models: availableModels });
const modelProvider = new DirectModelProvider(models);
const autoCheckpointAfterMs = Number(process.env.SANDBOX_AUTO_CHECKPOINT_AFTER_MS ?? 60 * 60 * 1000);
if (!Number.isFinite(autoCheckpointAfterMs) || autoCheckpointAfterMs <= 0) throw new Error('SANDBOX_AUTO_CHECKPOINT_AFTER_MS must be positive');
const projectSandboxes = new ProjectSandboxes(provider, sandboxImage, sandboxImageIdentity.templateId, cellboxRuntime.lifecycle,
  async id => { const project = await webState.getProject(id); return project?.removedAt ? undefined : project; });
const systemTools = new SystemTools({ projects: () => webState.listProjects(), enter: id => manager.enterProject(id),
  execute: (id, tool, args) => cellboxProvider.client.runTool(id, tool, args, 40_000) });
const notifications = new NotificationStore(webState.notificationRepository, process.env.NOTIFICATIONS_DATA_PATH ? resolve(process.env.NOTIFICATIONS_DATA_PATH) : undefined);
const runtime = new ContainerCodexRuntime({ sandboxes: projectSandboxes, provider, apiKey: apiKey || '',
  resolveModel: session => modelProvider.threadOptions(session),
  logger: runtimeLog, baseUrl: process.env.OPENAI_BASE_URL, modelConfig, configOverrides,
  sharedDataDirectory: pathToFileURL(`${sharedDataRoot}/`),
  ...(sharedDirectory ? { sharedFilesMounted: (id: string) => cellboxRuntime.usesSharedDirectory(id) } : {}),
  appServer, appServerReader, paths:CELLBOX_PRODUCT_PATHS, prepareRemote:(handle,target,signal,info)=>cellboxRuntime.prepare(handle,target,signal,info),
  remoteArchives:cellboxRuntime.remoteArchives,
  serviceAccess:(id:string,port:number)=>cellboxProvider.getServiceAccess(id,port) });
const webDataDirectory = resolve(process.env.CODEX_WEB_DATA_DIR || 'data/web-state');
const webImagesDirectory = resolve(process.env.CODEX_WEB_IMAGES_DIR || 'data/images');
const archivedReclaimAfterMs = Number(process.env.SANDBOX_ARCHIVED_RECLAIM_AFTER_MS ?? 24 * 60 * 60 * 1000);
const lifecycleScanIntervalMs = process.env.SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS === undefined ? undefined : Number(process.env.SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS);
if (!Number.isFinite(archivedReclaimAfterMs) || archivedReclaimAfterMs < 0) throw new Error('SANDBOX_ARCHIVED_RECLAIM_AFTER_MS must be non-negative');
manager = new SessionManager(codex, webDataDirectory, defaults, webState, runtime, sandboxWorkingDirectory, runtimeLog,
  webImagesDirectory, {
    onProjectCreate: projectId => secrets.repository.roles.assignDefault(projectId),
    requirementInfo: url => readSystemRequirementInfo(url, systemTools),
    archivedReclaimAfterMs,
    autoCheckpointAfterMs,
    ...(lifecycleScanIntervalMs === undefined ? {} : { scanIntervalMs: lifecycleScanIntervalMs }),
  }, notifications, coordinator);
manager.setModelService(models);
// Project tables must exist before the Secret schema's foreign keys are created.
const initializeSchemas = async () => { await webState.init(); await notifications.init(); await tools.init(); await secrets.init(); await models.init(); };
if (coordinator) await coordinator.run('cocell-schema-init', initializeSchemas);
else await initializeSchemas();
await manager.init();
// Paused instances are configured on resume. Running instances survive a web
// service restart; compare their durable acknowledgements before writing slots.
const reconcileProjects = async () => {
  await manager.refreshSharedState();
  for (const project of manager.listProjects()) {
    if (project.status === 'archived' || !project.sandbox) continue;
    const reconcile = async () => {
      await manager.refreshSharedState();
      if (manager.list().some(session => session.projectId === project.id && session.status === 'running')) return;
      await cellboxRuntime.reconcile({ id: project.id, projectId: project.id, updatedAt: project.updatedAt,
        settings: { workingDirectory: project.sandbox!.workingDirectory }, sandbox: project.sandbox });
    };
    try {
      await reconcile();
    } catch (error) { runtimeLog.write({ event: 'sandbox.runtime_config_reconcile_failed', projectId: project.id, error }); }
  }
};
if (coordinator) {
  const lease = await coordinator.tryAcquire('cocell-runtime-config-reconcile');
  if (lease) try { await reconcileProjects(); } finally { await lease.release(); }
} else await reconcileProjects();
const imageCatalog = new ImageCatalog(webState, cellboxProvider.client, process.env.CELLBOX_PROFILE!, undefined,
  () => webState.listProjects(), {defaultTemplateId:process.env.CELLBOX_TEMPLATE_ID,defaultRevisionId:process.env.CELLBOX_REVISION_ID});
await imageCatalog.init();
manager.setImageCatalog(imageCatalog);
const config: AppConfig = { models: availableModels, sandbox: { provider:'cellbox',kind:'k8s-resumable',enabled: true, image: sandboxImage, workingDirectory: sandboxWorkingDirectory,
  ...(sandboxImageIdentity ? { imageIdentity: sandboxImageIdentity } : {}),
  archivedReclaimAfterMs }, defaults, codexVersion: '0.153.4', auth: apiKey ? 'api-key' : 'local-codex',
  localWorkingDirectory, approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false, sandboxPreviews: true, nativeWebSocket: true } };
const publicUrl=cocellPublicUrl;
const previewSubdomains=process.env.COCELL_PREVIEW_SUBDOMAINS==='1';
const publicHost=new URL(publicUrl).host;
const additionalAllowedHosts = (process.env.ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const app = createApp(manager, config, [...new Set([`localhost:${port}`, `127.0.0.1:${port}`, publicHost,...additionalAllowedHosts])],
  inventory, new SharedFiles(sharedDataRoot, sharedDirectory, coordinator), undefined, notifications,
  { token:process.env.COCELL_ACCESS_TOKEN!,publicUrl,previewSubdomains,previewGrants:webState.previewGrants,refreshProjects:()=>manager.refreshSharedState(),projects:()=>manager.listProjects() }, imageCatalog, secrets, models);
let vite: import('vite').ViteDevServer | undefined;
if (process.env.NODE_ENV === 'production') installProductionStatic(app);
else { const { createServer: createViteServer } = await import('vite'); vite = await createViteServer({ server: { middlewareMode: true, ws:false, hmr:false }, appType: 'spa' }); }
const listener = getRequestListener(app.fetch);
const { isAuthenticatedDevRequest } = await import('./access/operator.js');
const previewProxy = previewSubdomains ? createPreviewProxy({ publicUrl, token: process.env.COCELL_ACCESS_TOKEN!,
  projects: () => manager.listProjects(), refreshProjects: () => manager.refreshSharedState(),
  access: (projectId, port, method, signal) => manager.projectServiceAccess(projectId, port, method, signal),
  onError: error => { void runtimeLog.write({ event: 'preview.proxy_failed', error }); },
}) : undefined;
const nativeRelay = createNativeRelay({ publicUrl, token: process.env.COCELL_ACCESS_TOKEN!,
  open: (id, signal) => manager.openNativeConnection(id, signal),
  observers: [{ name: 'runtime-log', observe: async event => {
    // Only metadata goes to logs. Native prompt/config bodies stay on the transport.
    if (event.direction === 'server' && (event.request || event.message.method?.startsWith('turn/')
      || event.message.method === 'thread/tokenUsage/updated')) {
      await runtimeLog.write({ event: 'app_server.message', sessionId: event.sessionId, connectionId: event.connectionId,
        method: event.message.method ?? event.request?.method, requestId: event.message.id,
        outcome: event.message.error ? 'error' : 'received',
        ...(event.message.method === 'thread/tokenUsage/updated' ? { usage: event.message.params?.tokenUsage?.last } : {}) });
    }
  } }, { name: 'session-projection', observe: event => manager.observeNativeMessage(event) }],
  onError: error => { void runtimeLog.write({ event: 'app_server.observer_or_transport_failed', error }); },
});
closeNativeSandboxConnections = id => nativeRelay.closeSandbox(id);
const server = createServer((request, response) => {
  void (async () => {
    if (previewProxy && await previewProxy.handle(request, response)) return;
    if (!vite || /^\/(?:api|mcp|auth)(?:\/|\?|$)/.test(request.url??'') ||
        !isAuthenticatedDevRequest(request,publicHost,process.env.COCELL_ACCESS_TOKEN!)) {
      await listener(request,response);
    } else vite.middlewares(request,response);
  })().catch(error => { void runtimeLog.write({ event: 'preview.request_failed', error }); response.destroy(); });
});
server.on('upgrade', (request, socket, head) => {
  if (nativeRelay.matches(request)) {
    void nativeRelay.upgrade(request, socket as import('node:net').Socket, head).catch(() => socket.destroy());
    return;
  }
  if (!previewProxy) { socket.destroy(); return; }
  void previewProxy.upgrade(request, socket as import('node:net').Socket, head).catch(() => socket.destroy());
});
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  void runtimeLog.write({ event: 'service.started', port, model: defaults.model, executionMode: 'sandbox' });
  console.log(`Codex Web ready at http://localhost:${port}`); console.log(`Sandbox: Cellbox image ${sandboxImage} · workspace ${sandboxWorkingDirectory}`);
});
let shuttingDown = false;
// Periodic sandbox archive for active projects — every 30 minutes
const archiveInterval = setInterval(() => { void manager.scheduledArchive().catch(() => {}); }, 60 * 1000);
archiveInterval.unref();
async function shutdown() { if (shuttingDown) return; shuttingDown = true; server.close(); await nativeRelay.close(); await previewProxy?.close(); await manager.close(); await cellboxRuntime.close();
  clearInterval(archiveInterval);
  await coordinator?.close();
  await runtimeLog.write({ event: 'service.stopped' }); await runtimeLog.flush(); await vite?.close(); server.closeAllConnections(); await shutdownTracing?.(); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
