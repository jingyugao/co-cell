import { CodexAppServerClient } from '../index.mjs';
import { startRuntime } from './server.mjs';
const appServer=await CodexAppServerClient.spawn({command:process.env.CODEX_PATH,cwd:process.env.AGENTCORE_CWD});
let runtime;
try{runtime=await startRuntime({appServer,directory:process.env.AGENTCORE_DATA_DIR??'.agentcore',token:process.env.AGENTCORE_TOKEN,host:process.env.AGENTCORE_HOST??'127.0.0.1',port:Number(process.env.AGENTCORE_PORT??8765)});}catch(error){await appServer.close();throw error;}
console.log(JSON.stringify({port:runtime.port,epoch:runtime.epoch}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void runtime.close().then(()=>process.exit(0));});
