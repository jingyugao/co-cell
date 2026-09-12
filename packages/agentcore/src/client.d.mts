export interface Cursor {after?:number;epoch?:string}
export interface RecordedEvent {seq:number;at:number;message:any;epoch?:string}
export class AgentClient {
 constructor(options:{endpoint:string;token:string});
 request(method:string,params?:unknown):Promise<any>;
 respond(id:string|number,result:unknown):Promise<unknown>;
 respondError(id:string|number,error:unknown):Promise<unknown>;
 readEvents(cursor?:Cursor):Promise<{epoch:string;events:RecordedEvent[];cursor:number}>;
 events(cursor?:Cursor):AsyncGenerator<RecordedEvent>;
 detach():void;
}
