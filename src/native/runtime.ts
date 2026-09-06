import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Workspace } from "../contracts/native.js";
import type { Config } from "./config.js";
import type { WorkspaceSandboxProvider } from "./e2b-provider.js";
import { SdkClient } from "./client.js";

export const quote=(s:string)=>`'${s.replace(/'/g,"'\\''")}'`;
export const cwdFor=(id:string)=>`/home/user/projects/${id}`;
const stateDir="/home/user/.local/share/swarm-hive-native";
export function initialCodexConfig(config:Config):string {
  const lines=["# Initial model connection only. Codex owns subsequent configuration."];
  if(config.model)lines.push(`model = ${JSON.stringify(config.model)}`);
  if(config.baseUrl&&config.modelKey)lines.push('model_provider = "configured"','[model_providers.configured]','name = "Configured Responses API"',`base_url = ${JSON.stringify(config.baseUrl)}`,'wire_api = "responses"','env_key = "OPENAI_API_KEY"');
  return lines.join("\n")+"\n";
}

export class NativeRuntime {
  private clients=new Map<string,SdkClient>();
  private opening=new Map<string,Promise<SdkClient>>();
  constructor(private provider:WorkspaceSandboxProvider,private config:Config){}
  connected(id:string):SdkClient {const client=this.clients.get(id);if(!client)throw new Error("Open the workspace first; passive reads never resume sandboxes");return client;}
  open(workspace:Workspace,persist:(sandboxId:string)=>void):Promise<SdkClient> {
    const existing=this.opening.get(workspace.id);if(existing)return existing;
    const promise=this.prepare(workspace,persist).finally(()=>this.opening.delete(workspace.id));this.opening.set(workspace.id,promise);return promise;
  }
  private async prepare(workspace:Workspace,persist:(id:string)=>void):Promise<SdkClient> {
    if(!/^[a-f0-9-]{36}$/i.test(workspace.id)||!this.config.secret)throw new Error("Invalid workspace identity or missing runtime secret");
    const sandbox=workspace.sandboxId?await this.provider.connect(workspace.sandboxId):await this.provider.create(workspace.id);
    if(!workspace.sandboxId)persist(sandbox.id);
    const token=createHmac("sha256",this.config.secret).update("native:"+workspace.id).digest("hex");
    const client=new SdkClient({baseUrl:sandbox.getProxyUrl(4097),token,headers:sandbox.getProxyHeaders(4097)});
    try {const health=await client.health();if(health.status!=="ready")throw new Error(`Native relay is ${health.status}; inspect sandbox logs`);this.clients.set(workspace.id,client);return client;}
    catch(error){if(error instanceof Error&&error.message.startsWith("Native relay is"))throw error;}
    // A timeout/401 is not evidence that the listener is absent.
    const probe="const n=require('node:net');const s=n.connect(4097,'127.0.0.1');s.on('connect',()=>process.exit(10));s.on('error',e=>process.exit(e.code==='ECONNREFUSED'?0:2));setTimeout(()=>process.exit(2),2000)";
    if((await sandbox.exec(`node -e ${quote(probe)}`,{user:"user",timeoutMs:4000})).exitCode!==0)throw new Error("Native listener exists or cannot be verified; refusing to start a second owner");
    const cwd=cwdFor(workspace.id);
    const setup=await sandbox.exec(`mkdir -p ${quote(cwd)} ${stateDir} /home/user/.codex /home/user/.local/bin && chmod 700 ${stateDir} /home/user/.codex`,{user:"user"});
    if(setup.exitCode)throw new Error("Unable to prepare native workspace");
    const envs:Record<string,string>={NATIVE_STATE_DIR:stateDir,NATIVE_TOKEN_FILE:stateDir+"/token",NATIVE_CWD:cwd,NATIVE_CODEX_PATH:"codex",NATIVE_PORT:"4097",NATIVE_SDK_MODULE:stateDir+"/sdk.mjs",
      PATH:"/home/user/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ...(this.config.modelKey?{OPENAI_API_KEY:this.config.modelKey}:{}),TRACE_TO_LANGFUSE:"false"};
    let version=await sandbox.exec("codex --version",{user:"user",envs});
    if(version.exitCode!==0){
      await sandbox.renewTimeout(30*60_000);
      const installed=await sandbox.exec(`npm install --prefix /home/user/.local --global --no-audit --no-fund @openai/codex@${this.config.version}`,{user:"user",envs,timeoutMs:10*60_000});
      if(installed.exitCode)throw new Error("Unable to install pinned Codex; sandbox preserved");
      version=await sandbox.exec("codex --version",{user:"user",envs});
    }
    if(version.stdout.trim()!==`codex-cli ${this.config.version}`)throw new Error("Sandbox Codex version differs from pinned version; not overwritten");
    const absent=await sandbox.exec("test ! -e /home/user/.codex/config.toml",{user:"user"});
    if(absent.exitCode===0)await sandbox.writeFile("/home/user/.codex/config.toml",initialCodexConfig(this.config));
    if(this.config.authPath&&(await sandbox.exec("test ! -e /home/user/.codex/auth.json",{user:"user"})).exitCode===0){
      await sandbox.writeFile("/home/user/.codex/auth.json",await readFile(this.config.authPath,"utf8"));
      await sandbox.exec("chmod 600 /home/user/.codex/auth.json",{user:"user"});
    }
    await sandbox.writeFile(stateDir+"/token",token);
    await sandbox.writeFile(stateDir+"/sdk-host.mjs",await readFile(fileURLToPath(new URL("./sdk-host.mjs",import.meta.url)),"utf8"));
    await sandbox.writeFile(stateDir+"/sdk.mjs",await readFile(new URL(import.meta.resolve("@openai/codex-sdk")),"utf8"));
    await sandbox.exec(`chmod 600 ${stateDir}/token`,{user:"user"});
    await sandbox.start(`node ${stateDir}/sdk-host.mjs >>${stateDir}/sdk-host.log 2>&1`,{cwd,user:"user",envs,timeoutMs:0});
    for(let n=0;n<40;n++){
      try {if((await client.health()).status==="ready"){this.clients.set(workspace.id,client);return client;}}catch{/* bounded readiness */}
      await new Promise(r=>setTimeout(r,500));
    }
    throw new Error("Codex SDK host did not become ready; sandbox and files preserved");
  }
}
