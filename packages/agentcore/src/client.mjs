/** Remote client owns only its HTTP requests, never the Agent process. */
export class AgentClient {
  constructor({endpoint,token}){this.endpoint=endpoint.replace(/\/$/,'');this.token=token;this.controller=new AbortController();}
  async call(path,body){
    const response=await fetch(this.endpoint+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:this.controller.signal});
    const value=await response.json();if(!response.ok)throw new Error(value.error??`HTTP ${response.status}`);return value;
  }
  async request(method,params){return (await this.call('/rpc',{method,params})).result;}
  respond(id,result){return this.call('/respond',{id,result});}
  respondError(id,error){return this.call('/respond',{id,error});}
  readEvents({after=0,epoch}={}){return this.call(`/events?after=${after}${epoch?'&epoch='+encodeURIComponent(epoch):''}`);}
  async *events({after=0,epoch}={}){
    while(!this.controller.signal.aborted){
      const page=await this.readEvents({after,epoch});epoch=page.epoch;
      for(const event of page.events){yield {...event,epoch};after=event.seq;}
      if(!page.events.length)await new Promise((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(this.controller.signal.reason);};const timer=setTimeout(()=>{this.controller.signal.removeEventListener('abort',abort);resolve();},250);this.controller.signal.addEventListener('abort',abort,{once:true});if(this.controller.signal.aborted)abort();
      });
    }
  }
  detach(){this.controller.abort(new Error('Client detached'));}
}
