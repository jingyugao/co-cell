import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Workspace } from "../contracts/native.js";

/** One controller process owns this registry; native Codex owns all conversations. */
export class WorkspaceStore {
  private rows:Workspace[];
  private path:string;
  constructor(directory:string) {
    mkdirSync(directory,{recursive:true,mode:0o700});this.path=join(directory,"workspaces.json");
    try {const parsed:unknown=JSON.parse(readFileSync(this.path,"utf8"));
      if(!Array.isArray(parsed)||parsed.some(r=>!r||typeof r.id!=="string"||typeof r.title!=="string"||typeof r.sourceUrl!=="string"||typeof r.createdAt!=="string"||(r.sandboxId!==null&&typeof r.sandboxId!=="string")||(r.threadId!==null&&typeof r.threadId!=="string")))throw new Error("Invalid registry");
      this.rows=parsed;
    } catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("Unable to read native workspace registry; refusing to reset it");this.rows=[];}
  }
  list():Workspace[]{return structuredClone(this.rows);}
  get(id:string):Workspace {const row=this.rows.find(r=>r.id===id);if(!row)throw new Error("Workspace not found");return structuredClone(row);}
  create(title:string,sourceUrl=""):Workspace {
    const row:Workspace={id:randomUUID(),title,sourceUrl,sandboxId:null,threadId:null,createdAt:new Date().toISOString()};
    this.save([...this.rows,row]);return structuredClone(row);
  }
  patch(id:string,patch:Partial<Pick<Workspace,"sandboxId"|"threadId">>):Workspace {
    const row={...this.get(id),...patch};this.save(this.rows.map(r=>r.id===id?row:r));return row;
  }
  private save(rows:Workspace[]) {
    const temporary=this.path+"."+randomUUID()+".tmp";
    writeFileSync(temporary,JSON.stringify(rows,null,2),{flag:"wx",mode:0o600});renameSync(temporary,this.path);this.rows=rows;
  }
}
