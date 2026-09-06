import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { Config } from "../native/config.js";
import { configuration } from "../native/config.js";
import type { WorkspaceStore } from "../native/store.js";
import type { NativeRuntime } from "../native/runtime.js";
import { SdkHttpError } from "../native/client.js";

export function createApp(config:Config,store:WorkspaceStore,runtime?:NativeRuntime):Hono {
  const app=new Hono();app.use("*",secureHeaders());
  app.use("/api/*",async(c,next)=>{
    c.header("Cache-Control","no-store");
    if(!["GET","HEAD","OPTIONS"].includes(c.req.method)){
      const origin=c.req.header("origin"),site=c.req.header("sec-fetch-site");
      if((site&&!['same-origin','none'].includes(site))||(origin&&origin!==(config.publicOrigin??new URL(c.req.url).origin)))return c.json({error:"Cross-origin writes are not allowed"},403);
    }
    await next();
  });
  app.use("/api/*",bodyLimit({maxSize:1_048_576,onError:c=>c.json({error:"Request exceeds 1 MiB"},413)}));
  const get=(id:string)=>{const parsed=z.string().uuid().safeParse(id);if(!parsed.success)return null;try{return store.get(id);}catch{return null;}};
  app.get("/healthz",c=>c.json({status:"ok"}));
  app.get("/api/info",c=>c.json(configuration(config)));
  app.get("/api/workspaces",c=>c.json({items:store.list()}));
  app.post("/api/workspaces",async c=>{
    const input=z.object({title:z.string().trim().min(1).max(200),sourceUrl:z.string().max(2000).optional().refine(v=>!v||/^https?:\/\//.test(v))}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!input.success)return c.json({error:"Provide title and optional sourceUrl"},400);
    return c.json(store.create(input.data.title,input.data.sourceUrl),201);
  });
  app.post("/api/workspaces/:id/open",async c=>{
    const workspace=get(c.req.param("id"));if(!workspace)return c.json({error:"Workspace not found"},404);
    if(!runtime)return c.json({error:"Configure E2B and Codex credentials first"},503);
    const client=await runtime.open(workspace,id=>{store.patch(workspace.id,{sandboxId:id});});
    return c.json({workspace:store.get(workspace.id),health:await client.health()});
  });
  app.get("/api/workspaces/:id/events",async c=>{
    const workspace=get(c.req.param("id"));if(!workspace)return c.json({error:"Workspace not found"},404);
    const cursor=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).safeParse(c.req.query("after")??0);
    if(!cursor.success)return c.json({error:"Invalid event cursor"},400);
    return c.json(await runtime!.connected(workspace.id).events(cursor.data));
  });
  app.post("/api/workspaces/:id/runs",async c=>{
    const workspace=get(c.req.param("id"));if(!workspace)return c.json({error:"Workspace not found"},404);
    const body=z.object({requestId:z.string().uuid(),threadId:z.string().min(1).max(200).optional(),input:z.union([
      z.string().min(1),z.array(z.union([z.object({type:z.literal("text"),text:z.string()}).strict(),z.object({type:z.literal("local_image"),path:z.string().min(1)}).strict()])).min(1),
    ])}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!body.success)return c.json({error:"Provide requestId, SDK input and optional native threadId"},400);
    // No model, instructions, workflow, tool, input or native identity rewriting.
    return c.json(await runtime!.connected(workspace.id).run(body.data),202);
  });
  app.post("/api/workspaces/:id/runs/:requestId/interrupt",async c=>{
    const workspace=get(c.req.param("id"));if(!workspace)return c.json({error:"Workspace not found"},404);
    const requestId=z.string().uuid().safeParse(c.req.param("requestId"));
    if(!requestId.success)return c.json({error:"Invalid request ID"},400);
    await runtime!.connected(workspace.id).interrupt(requestId.data);return c.json({ok:true});
  });
  app.all("/api/*",c=>c.json({error:"Unknown API route"},404));
  if(existsSync(resolve(config.webRoot,"index.html"))){
    app.use("/*",serveStatic({root:config.webRoot}));app.get("/*",serveStatic({path:resolve(config.webRoot,"index.html")}));
  }
  app.onError((error,c)=>{
    if(error instanceof SdkHttpError && [400,401,403,404,409,413].includes(error.status))return c.json({error:error.message},error.status as 400|401|403|404|409|413);
    return c.json({error:"SDK operation failed. A submitted request may still be running; reconnect and inspect history before retrying."},503);
  });
  return app;
}
