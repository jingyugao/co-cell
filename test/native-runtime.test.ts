import { randomUUID } from "node:crypto";
import { afterEach,describe,expect,test,vi } from "vitest";
import { loadConfig } from "../src/native/config.js";
import { NativeRuntime } from "../src/native/runtime.js";
import type { WorkspaceSandbox,WorkspaceSandboxProvider } from "../src/native/e2b-provider.js";
import type { Workspace } from "../src/contracts/native.js";

afterEach(()=>vi.unstubAllGlobals());
function fixture(){
  const config=loadConfig({CODEX_WORKSPACE_SECRET:"s".repeat(32),OPENAI_API_KEY:"private-api-key",OPENAI_BASE_URL:"https://model.test/v1",CODEX_MODEL:"gpt-5.6-sol"});
  const files=new Map<string,string>();let listening=false;let uncertainListener=false;
  const sandbox:WorkspaceSandbox={id:"sandbox",writeFile:vi.fn(async(p,c)=>{files.set(p,c);}),readFile:vi.fn(async p=>{if(!files.has(p))throw Error("missing");return files.get(p)!;}),
    exec:vi.fn(async cmd=>{
      if(cmd.includes("net")&&cmd.includes("4097"))return{stdout:"",stderr:"",exitCode:uncertainListener?10:0};
      if(cmd==="codex --version")return{stdout:"codex-cli 0.153.4\n",stderr:"",exitCode:0};
      if(cmd.startsWith("test ! -e "))return{stdout:"",stderr:"",exitCode:files.has(cmd.slice(10))?1:0};
      return{stdout:"",stderr:"",exitCode:0};
    }),start:vi.fn(async()=>{listening=true;return{pid:42};}),pause:vi.fn(),renewTimeout:vi.fn(),getHost:()=>"sandbox.test",getProxyUrl:()=>"https://sandbox.test",getProxyHeaders:()=>({"e2b-access-token":"private-proxy"})};
  const provider:WorkspaceSandboxProvider={create:vi.fn(async()=>sandbox),connect:vi.fn(async()=>sandbox)};
  const row:Workspace={id:randomUUID(),title:"test",sourceUrl:"",createdAt:"now",sandboxId:null,threadId:null};
  const fetch=vi.fn(async()=>{if(!listening)throw Error("ECONNREFUSED");return new Response(JSON.stringify({status:"ready",instanceId:"host",activeRequestId:null}),{status:200});});vi.stubGlobal("fetch",fetch);
  return{config,files,sandbox,provider,row,fetch,runtime:new NativeRuntime(provider,config),setListening:()=>{listening=true;},setUncertain:()=>{uncertainListener=true;}};
}
describe("SDK runs wholly inside E2B",()=>{
  test("persists sandbox identity then starts only SDK host with explicit model credentials",async()=>{
    const f=fixture(),ids:string[]=[];
    await f.runtime.open(f.row,id=>ids.push(id));
    expect(ids).toEqual(["sandbox"]);
    const [cmd,options]=vi.mocked(f.sandbox.start).mock.calls[0]!;
    expect(cmd).toContain("sdk-host.mjs");expect(cmd).not.toContain("app-server");
    expect(options?.envs).toMatchObject({OPENAI_API_KEY:"private-api-key",NATIVE_CWD:`/home/user/projects/${f.row.id}`});
    for(const key of ["E2B_API_KEY","CODEX_WORKSPACE_SECRET","MEEGLE_USER_ACCESS_TOKEN","GITLAB_TOKEN"])expect(options?.envs).not.toHaveProperty(key);
    expect(f.files.get("/home/user/.local/share/swarm-hive-native/sdk.mjs")).toContain("runStreamed");
    const native=f.files.get("/home/user/.codex/config.toml")!;
    expect(native).not.toMatch(/developer_instructions|mcp_servers|approval|sandbox|memory|private-api-key/);
  });
  test("healthy reconnect does not rewrite configuration, files or start processes",async()=>{
    const f=fixture();f.setListening();await f.runtime.open({...f.row,sandboxId:"sandbox"},()=>{throw Error("unexpected new sandbox");});
    expect(f.provider.connect).toHaveBeenCalledWith("sandbox");expect(f.sandbox.start).not.toHaveBeenCalled();expect(f.sandbox.writeFile).not.toHaveBeenCalled();
  });
  test("keeps user Codex configuration intact and does not replace saved environments",async()=>{
    const f=fixture();f.files.set("/home/user/.codex/config.toml","# user config");
    await f.runtime.open({...f.row,sandboxId:"sandbox"},()=>{});
    expect(f.files.get("/home/user/.codex/config.toml")).toBe("# user config");expect(f.provider.create).not.toHaveBeenCalled();
  });
  test("fails closed when proxy is unreachable but native listener might still be alive",async()=>{
    const f=fixture();f.setUncertain();await expect(f.runtime.open({...f.row,sandboxId:"sandbox"},()=>{})).rejects.toThrow("second owner");
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();expect(f.sandbox.start).not.toHaveBeenCalled();
  });
  test("passive access never creates or resumes a sandbox",()=>{
    const f=fixture();expect(()=>f.runtime.connected(f.row.id)).toThrow("Open the workspace");expect(f.provider.create).not.toHaveBeenCalled();expect(f.provider.connect).not.toHaveBeenCalled();
  });
});
