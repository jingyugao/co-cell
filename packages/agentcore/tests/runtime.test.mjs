import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../src/runtime/server.mjs';
import { AgentClient } from '../src/client.mjs';
import { Journal } from '../src/runtime/journal.mjs';
const token='test-token-at-least-24-characters';
test('detached client cannot terminate runtime; next client replays and continues',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentcore-')); const app=new EventEmitter();let closed=false;
 app.request=async(method,params)=>{if(method==='turn/start')setTimeout(()=>app.emit('notification',{method:'turn/completed',params}),30);return {threadId:params.threadId};};app.close=async()=>{closed=true;};
 const runtime=await startRuntime({appServer:app,directory:dir,token});
 try{
 const options={endpoint:`http://127.0.0.1:${runtime.port}`,token};const first=new AgentClient(options);const state=await first.readEvents();await first.request('turn/start',{threadId:'thread-1'});first.detach();await new Promise(r=>setTimeout(r,60));assert.equal(closed,false);
 const second=new AgentClient(options);const page=await second.readEvents({after:state.cursor,epoch:state.epoch});assert.equal(page.events[0].message.params.threadId,'thread-1');assert.equal((await second.request('turn/start',{threadId:'thread-1'})).threadId,'thread-1');await assert.rejects(second.readEvents({epoch:'wrong'}),/resync/);second.detach();await new Promise(r=>setTimeout(r,60));
 }finally{await runtime.close();await rm(dir,{recursive:true,force:true});}
});
test('journal persists sequence, pages without duplicate, repairs incomplete tail',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentcore-journal-'));let journal=await Journal.open(dir);
 try{await Promise.all(Array.from({length:300},(_,i)=>journal.append({i})));const p=await journal.page();assert.equal(p.events.length,200);const epoch=p.epoch;await journal.close();await appendFile(join(dir,'events.jsonl'),'{partial');journal=await Journal.open(dir);const rest=await journal.page(200);assert.equal(rest.epoch,epoch);assert.equal(rest.events.length,100);assert.equal(rest.events[0].seq,201);await assert.rejects(journal.page(500),/cursor/);}finally{await journal.close();await rm(dir,{recursive:true,force:true});}
});
