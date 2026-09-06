export interface Workspace {
  id:string; title:string; sourceUrl:string; sandboxId:string|null; threadId:string|null; createdAt:string;
}
import type { ThreadEvent, UserInput } from "@openai/codex-sdk";
export type SdkInput = string | UserInput[];
/** requestId correlates HTTP submissions; it is NOT a Codex turn or thread ID. */
export interface SdkRun {requestId:string;threadId:string|null;input:SdkInput;status:"running"|"completed"|"failed"|"interrupted";createdAt:string;error?:string}
/** Native SDK events are preserved without renaming, projection or invented IDs. */
export interface NativeEvent {seq:number;requestId:string;event:ThreadEvent}
export interface NativeEvents {instanceId:string;events:NativeEvent[];nextAfter:number;runs:SdkRun[]}
export interface NativeHealth {status:"ready";instanceId:string;activeRequestId:string|null}
export interface WorkbenchInfo {engine:string;version:string;model:string|null;configured:boolean;missing:string[];note:string}
