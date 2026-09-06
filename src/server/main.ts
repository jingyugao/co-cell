import { serve } from "@hono/node-server";
import { loadConfig,configuration } from "../native/config.js";
import { WorkspaceStore } from "../native/store.js";
import { E2BWorkspaceProvider } from "../native/e2b-provider.js";
import { NativeRuntime } from "../native/runtime.js";
import { createApp } from "./app.js";

const config=loadConfig();
const runtime=configuration(config).configured?new NativeRuntime(new E2BWorkspaceProvider({
  apiKey:config.apiKey!,domain:config.domain!,apiUrl:config.apiUrl,sandboxUrl:config.sandboxUrl,template:config.template!,timeoutMs:30*60_000,
}),config):undefined;
const app=createApp(config,new WorkspaceStore(config.dataDir),runtime);
const server=serve({fetch:app.fetch,hostname:config.host,port:config.port},()=>console.log(`Native Codex workbench: http://${config.host}:${config.port}`));
// Controller shutdown never kills sandbox-owned SDK processes or projects.
for(const signal of ["SIGTERM","SIGINT"] as const)process.on(signal,()=>server.close(()=>process.exit(0)));
