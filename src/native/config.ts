import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkbenchInfo } from "../contracts/native.js";

export interface Config {
  host:string;port:number;dataDir:string;webRoot:string;publicOrigin?:string;
  apiKey?:string;domain?:string;apiUrl?:string;sandboxUrl?:string;template?:string;
  secret?:string;version:string;model?:string;baseUrl?:string;modelKey?:string;authPath?:string;
}
export function loadConfig(env:NodeJS.ProcessEnv=process.env):Config {
  const v=(key:string)=>env[key]?.trim()||undefined;
  const port=Number(v("AGENT_SERVER_PORT")??3000);
  if(!Number.isSafeInteger(port)||port<1||port>65535) throw new Error("Invalid AGENT_SERVER_PORT");
  let apiKey=v("E2B_API_KEY");
  if(!apiKey&&v("E2B_API_KEY_FILE")) {try{apiKey=readFileSync(resolve(v("E2B_API_KEY_FILE")!),"utf8").trim();}catch{throw new Error("Cannot read E2B_API_KEY_FILE");}}
  const version=v("CODEX_VERSION")??"0.153.4";
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error("CODEX_VERSION must be pinned");
  const secret=v("CODEX_WORKSPACE_SECRET");if(secret&&secret.length<32)throw new Error("CODEX_WORKSPACE_SECRET must have at least 32 characters");
  const baseUrl=v("OPENAI_BASE_URL");
  if(baseUrl){const u=new URL(baseUrl);if(!["http:","https:"].includes(u.protocol)||u.username||u.password)throw new Error("Invalid OPENAI_BASE_URL");}
  const publicOrigin=v("CODEX_PUBLIC_ORIGIN");
  if(publicOrigin){const u=new URL(publicOrigin);if(!["http:","https:"].includes(u.protocol)||u.origin!==publicOrigin)throw new Error("Invalid CODEX_PUBLIC_ORIGIN");}
  return {host:v("AGENT_SERVER_HOST")??"127.0.0.1",port,dataDir:resolve(v("NATIVE_DATA_DIR")??"data/native"),webRoot:resolve(v("AGENT_WEB_ROOT")??"dist/web"),
    publicOrigin,apiKey,domain:v("E2B_DOMAIN"),apiUrl:v("E2B_API_URL"),sandboxUrl:v("E2B_SANDBOX_URL"),template:v("E2B_TEMPLATE"),
    secret,version,model:v("CODEX_MODEL"),baseUrl,modelKey:v("OPENAI_API_KEY"),authPath:v("CODEX_AUTH_JSON_PATH")};
}
export function configuration(config:Config):WorkbenchInfo {
  const missing=Object.entries({E2B_API_KEY:config.apiKey,E2B_DOMAIN:config.domain,E2B_TEMPLATE:config.template,CODEX_WORKSPACE_SECRET:config.secret,
    "OPENAI_API_KEY or CODEX_AUTH_JSON_PATH":config.modelKey||config.authPath}).filter(([,v])=>!v).map(([k])=>k);
  return {engine:"@openai/codex-sdk",version:config.version,model:config.model??null,configured:missing.length===0,missing,
    note:"原生 Codex 运行于 E2B。此客户端不注入研发流程、记忆或自定义工具；默认读取沙箱中的 Codex 配置。旧需求与沙箱数据保留，未自动导入本工作台。"};
}
