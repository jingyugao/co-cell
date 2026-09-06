/** Opt-in: two harmless model turns in a disposable E2B sandbox.
 * node --env-file=.env --import tsx scripts/sdk-e2b-smoke.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import { loadConfig } from "../src/native/config.js";
import { E2BWorkspaceProvider } from "../src/native/e2b-provider.js";
import { NativeRuntime, cwdFor } from "../src/native/runtime.js";
import type { Workspace,NativeEvent } from "../src/contracts/native.js";
import { redactSensitiveText } from "../src/security/redact.js";

const config=loadConfig();
const options={apiKey:config.apiKey!,domain:config.domain!,apiUrl:config.apiUrl,sandboxUrl:config.sandboxUrl,template:config.template!,timeoutMs:30*60_000};
const provider=new E2BWorkspaceProvider(options);
const row:Workspace={id:randomUUID(),title:"SDK smoke only",sourceUrl:"",sandboxId:null,threadId:null,createdAt:new Date().toISOString()};
try {
  const runtime=new NativeRuntime(provider,config);
  const client=await runtime.open(row,id=>{row.sandboxId=id;console.log("Created own smoke sandbox:",id);});
  const original=await client.health();
  const collected:NativeEvent[]=[];let after=0;
  async function run(input:string,threadId?:string){
    const requestId=randomUUID();
    await client.run({requestId,input,...(threadId?{threadId}:{})});
    for(let n=0;n<240;n++){
      const page=await client.events(after);after=page.nextAfter;collected.push(...page.events);
      const run=page.runs.find(r=>r.requestId===requestId);
      if(run&&run.status!=="running"){
        assert.equal(run.status,"completed",`SDK run ${run.status}: ${run.error??""}`);
        assert.ok(run.threadId);return run.threadId;
      }
      await new Promise(r=>setTimeout(r,1000));
    }
    await client.interrupt(requestId);throw new Error("Smoke turn timed out");
  }
  const nativeId=await run("Run the harmless shell command printf 'sdk-native-ok\\n'. Also create sdk-smoke.txt in the current workspace containing exactly sdk-native-ok followed by a newline, then reply SDK_OK. Do not inspect credentials or unrelated files.");
  console.log("First native thread:",nativeId);
  assert.ok(collected.some(e=>e.event.type==="item.completed"&&e.event.item.type==="command_execution"),"Missing native shell execution item");
  assert.equal(await (await provider.connect(row.sandboxId!)).readFile(cwdFor(row.id)+"/sdk-smoke.txt"),"sdk-native-ok\n","Native workspace editing failed");
  // Fresh controller object reconnects to the existing sandbox-owned process.
  const reconnected=await new NativeRuntime(provider,config).open(row,()=>{throw new Error("Unexpected replacement sandbox");});
  assert.equal((await reconnected.health()).instanceId,original.instanceId);
  assert.equal(await run("What exact marker did the previous shell command print? Reply only the marker; do not run commands.",nativeId),nativeId);
  const reply=collected.filter(e=>e.event.type==="item.completed"&&e.event.item.type==="agent_message").at(-1);
  assert.ok(reply?.event.type==="item.completed"&&reply.event.item.type==="agent_message"&&reply.event.item.text.includes("sdk-native-ok"),"Native context was not continued");
  console.log(JSON.stringify({engine:"@openai/codex-sdk",nativeThreadId:nativeId,eventTypes:[...new Set(collected.map(e=>e.event.type))],result:"native shell, raw SDK events, same-thread context and controller reconnection verified"}));
} catch(error) {
  if(row.sandboxId) {
    try {
      const sandbox=await provider.connect(row.sandboxId);
      const journal=await sandbox.readFile("/home/user/.local/share/swarm-hive-native/sdk-events.jsonl");
      const failures=journal.split("\n").filter(Boolean).map(line=>JSON.parse(line).event).filter(event=>event.type==="error"||event.type==="turn.failed");
      let log=JSON.stringify(failures)+"\n";
      try{log+=await sandbox.readFile("/home/user/.local/share/swarm-hive-native/sdk-errors.log");}catch{/* raw events may be sufficient */}
      for(const secret of [config.apiKey,config.secret,config.modelKey])if(secret)log=log.replaceAll(secret,"[REDACTED]");
      console.error(redactSensitiveText(log).slice(-5000));
    } catch {console.error("No SDK error log available");}
  }
  throw error;
} finally {
  if(row.sandboxId){assert.ok(await Sandbox.kill(row.sandboxId,options),"Smoke sandbox cleanup failed");console.log("Deleted only own smoke sandbox:",row.sandboxId);}
}
