import { mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach,describe,expect,test,vi } from "vitest";
import { loadConfig,configuration } from "../src/native/config.js";
import { WorkspaceStore } from "../src/native/store.js";
import { initialCodexConfig } from "../src/native/runtime.js";
import type { NativeRuntime } from "../src/native/runtime.js";
import { createApp } from "../src/server/app.js";

const dirs:string[]=[];
function directory(){const p=mkdtempSync(join(tmpdir(),"native-sdk-test-"));dirs.push(p);return p;}
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});

describe("clean SDK workbench registry/config",()=>{
  test("uses independent metadata and preserves native thread identity on reload",()=>{
    const d=directory(),store=new WorkspaceStore(d),row=store.create("需求","https://project.feishu.cn/demo/story/detail/123");
    expect(row.sandboxId).toBeNull();expect(row.threadId).toBeNull();
    store.patch(row.id,{sandboxId:"sandbox",threadId:"native-thread"});
    expect(new WorkspaceStore(d).get(row.id)).toMatchObject({threadId:"native-thread",sandboxId:"sandbox"});
    const rows=store.list();rows[0]!.title="mutated";expect(store.get(row.id).title).toBe("需求");
    expect(()=>store.patch(randomUUID(),{sandboxId:"wrong"})).toThrow("not found");
  });
  test("never resets a damaged registry",()=>{
    const d=directory();writeFileSync(join(d,"workspaces.json"),"broken");
    expect(()=>new WorkspaceStore(d)).toThrow("refusing to reset");
    expect(readFileSync(join(d,"workspaces.json"),"utf8")).toBe("broken");
  });
  test("does not inject legacy workflows, memory, tools, permissions or secrets into Codex config",()=>{
    const c=loadConfig({OPENAI_API_KEY:"private-model-key",OPENAI_BASE_URL:"https://model.test/v1",CODEX_MODEL:"gpt-5.6-sol",MEM0_ENABLED:"true",TRACE_TO_LANGFUSE:"true",FeishuProjectMcpToken:"private-meegle"});
    const result=initialCodexConfig(c);
    expect(result).toContain('model = "gpt-5.6-sol"');expect(result).toContain('env_key = "OPENAI_API_KEY"');
    expect(result).not.toMatch(/private-model-key|private-meegle|developer_instructions|mcp_servers|approval|sandbox|memory|hooks/);
    expect(configuration(c).engine).toBe("@openai/codex-sdk");
    expect(JSON.stringify(configuration(c))).not.toContain("private-model-key");
  });
  test("requires explicit E2B configuration and does not read old database settings",()=>{
    const c=loadConfig({AGENT_DATABASE_URL:"postgres://private",MEM0_ENABLED:"true"});
    expect(configuration(c).configured).toBe(false);expect(c.domain).toBeUndefined();
    expect(c.dataDir).toMatch(/data\/native$/);expect(c).not.toHaveProperty("databaseUrl");
    expect(()=>loadConfig({CODEX_VERSION:"latest"})).toThrow("pinned");
    expect(()=>loadConfig({AGENT_SERVER_PORT:"0"})).toThrow("PORT");
  });
});

describe("SDK API is transport, not app-server or workflow",()=>{
  function fixture(){
    const d=directory(),config=loadConfig({NATIVE_DATA_DIR:d,AGENT_WEB_ROOT:d}),store=new WorkspaceStore(d);
    const row=store.create("SDK test");const input={requestId:randomUUID(),input:"  exact message\n",threadId:"native-id"};
    const client={run:vi.fn(async(body:unknown)=>({...body as object,status:"running",threadId:"native-id",createdAt:"now"})),health:vi.fn(async()=>({status:"ready",instanceId:"host",activeRequestId:null})),events:vi.fn(async()=>({instanceId:"host",events:[],nextAfter:0,runs:[]})),interrupt:vi.fn(async()=>{})};
    const runtime={open:vi.fn(async()=>client),connected:vi.fn(()=>client)};
    return {app:createApp(config,store,runtime as unknown as NativeRuntime),store,row,runtime,client,input};
  }
  const post=(body:unknown)=>({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  test("listing and creating workspaces never launches environments or model requests",async()=>{
    const f=fixture();expect((await f.app.request("/api/info")).status).toBe(200);
    expect((await f.app.request("/api/workspaces")).status).toBe(200);
    expect((await f.app.request("/api/workspaces",post({title:"new"}))).status).toBe(201);
    expect(f.runtime.open).not.toHaveBeenCalled();expect(f.client.run).not.toHaveBeenCalled();
  });
  test("opening only connects the environment",async()=>{
    const f=fixture();expect((await f.app.request(`/api/workspaces/${f.row.id}/open`,post({}))).status).toBe(200);
    expect(f.client.run).not.toHaveBeenCalled();
  });
  test("forwards SDK inputs and native thread IDs unchanged, including local images",async()=>{
    const f=fixture(),path=`/api/workspaces/${f.row.id}/runs`;
    expect((await f.app.request(path,post(f.input))).status).toBe(202);
    expect(f.client.run).toHaveBeenCalledWith(f.input);
    const image={requestId:randomUUID(),input:[{type:"text",text:"inspect"},{type:"local_image",path:"/home/user/projects/image.png"}]};
    expect((await f.app.request(path,post(image))).status).toBe(202);expect(f.client.run).toHaveBeenLastCalledWith(image);
    expect((await f.app.request(path,post({...image,developerInstructions:"override"}))).status).toBe(400);
    expect((await f.app.request(path,post({...image,requestId:"bad"}))).status).toBe(400);
  });
  test("does not expose old workflow or synthetic app-server endpoints",async()=>{
    const f=fixture();for(const suffix of ["rpc","respond","select-thread","approve","develop"]){
      expect((await f.app.request(`/api/workspaces/${f.row.id}/${suffix}`,post({}))).status).toBe(404);
    }
    expect((await f.app.request("/api/v1/codex/workspaces")).status).toBe(404);
  });
  test("rejects cross-origin writes and avoids caching private events",async()=>{
    const f=fixture();const response=await f.app.request(`/api/workspaces/${f.row.id}/runs`,{...post(f.input),headers:{origin:"https://evil.test","content-type":"application/json"}});
    expect(response.status).toBe(403);expect(f.client.run).not.toHaveBeenCalled();
    const events=await f.app.request(`/api/workspaces/${f.row.id}/events`);expect(events.headers.get("cache-control")).toBe("no-store");
    expect((await f.app.request(`/api/workspaces/${f.row.id}/events?after=-1`)).status).toBe(400);
  });
});
