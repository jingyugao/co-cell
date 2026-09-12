import type { CodexAppServerClient } from '../index.mjs';
export function startRuntime(options:{appServer:CodexAppServerClient;directory:string;token:string;port?:number;host?:string}):Promise<{port:number;epoch:string;close():Promise<void>}>;
