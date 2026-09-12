import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Journal } from './journal.mjs';
export async function startRuntime({ appServer, directory, token, port=0, host='127.0.0.1' }) {
  if(!token || token.length<24) throw new Error('Runtime bearer token must have at least 24 characters');
  const journal=await Journal.open(directory);
  let failure; const outstanding=new Map();
  const record=message=>{void journal.append(message).catch(error=>{failure=error;});};
  const notification=message=>record(message);
  const request=message=>{outstanding.set(String(message.id),message.id);record(message);};
  appServer.on('notification',notification);appServer.on('request',request);
  appServer.on('closed',error=>{failure=error??new Error('App Server closed');record({method:'runtime/exited',params:{message:failure.message}});});
  const server=createServer(async(req,res)=>{
    const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    const supplied=Buffer.from(req.headers.authorization??'');const expected=Buffer.from(`Bearer ${token}`);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){reply(401,{error:'Unauthorized'});return;}
    try{
      const url=new URL(req.url,'http://runtime');
      if(req.method==='GET'&&url.pathname==='/events'){
        if(url.searchParams.has('epoch')&&url.searchParams.get('epoch')!==journal.epoch){reply(409,{error:'Journal changed; history resync required'});return;}
        reply(200,await journal.page(Number(url.searchParams.get('after')??0)));return;
      }
      if(req.method==='GET'&&url.pathname==='/health'){reply(failure?503:200,{epoch:journal.epoch,ready:!failure});return;}
      if(req.method!=='POST'||!['/rpc','/respond'].includes(url.pathname)){reply(404,{error:'Not found'});return;}
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024){reply(413,{error:'Request too large'});return;}chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if(failure)throw failure;
      if(url.pathname==='/respond'){
        const key=String(body.id);if(!outstanding.has(key))throw new Error('Server request already answered or unknown');
        const id=outstanding.get(key);body.error?appServer.respondError(id,body.error):appServer.respond(id,body.result);outstanding.delete(key);reply(200,{});return;
      }
      if(typeof body.method!=='string'||['initialize','initialized'].includes(body.method))throw new Error('Invalid method');
      const result=await appServer.request(body.method,body.params);reply(200,{result});
    }catch(error){reply(400,{error:error.message});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {port:server.address().port,epoch:journal.epoch,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));appServer.off('notification',notification);appServer.off('request',request);await appServer.close();await journal.close();}};
}
