import type { NativeEvents, NativeHealth, SdkInput, SdkRun, WorkbenchInfo, Workspace } from "../../src/contracts/native.js";

export function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function text(value: unknown): string { return typeof value === "string" ? value : ""; }
export function json(value: unknown): string { return JSON.stringify(value, null, 2) ?? ""; }
export function workspaceRoute(path: string): string | null {
  const match = /^\/workspaces\/([^/]+)\/?$/.exec(path);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
}
export function workspaceUrl(id: string): string { return `/workspaces/${encodeURIComponent(id)}`; }
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(text(object(object(result).error).message) || text(object(result).error) || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
const path = (id: string) => `/workspaces/${encodeURIComponent(id)}`;
export const api = {
  info: (signal?: AbortSignal) => request<WorkbenchInfo>("/info", undefined, signal),
  list: (signal?: AbortSignal) => request<{ items: Workspace[] }>("/workspaces", undefined, signal),
  create: (title: string, sourceUrl?: string) => request<Workspace>("/workspaces", { title, ...(sourceUrl ? { sourceUrl } : {}) }),
  open: (id: string) => request<{ workspace: Workspace; health: NativeHealth }>(`${path(id)}/open`, {}),
  run: (id: string, requestId: string, input: SdkInput, threadId?: string) => request<SdkRun>(`${path(id)}/runs`, { requestId, input, ...(threadId ? { threadId } : {}) }),
  events: (id: string, after: number, signal?: AbortSignal) => request<NativeEvents>(`${path(id)}/events?after=${after}`, undefined, signal),
  interrupt: (id: string, requestId: string) => request<unknown>(`${path(id)}/runs/${encodeURIComponent(requestId)}/interrupt`, {}),
};

export function sdkInput(content: string, imagePath: string): SdkInput {
  if (!content.trim() && !imagePath.trim()) throw new Error("请输入消息或沙箱内图片路径。");
  if (!imagePath.trim()) return content; // Preserve exact user text, without an injected task or template.
  const path = imagePath.trim();
  if (!path.startsWith("/") || /^[a-z]+:\/\//i.test(path)) throw new Error("图片必须是沙箱内的绝对文件路径，不是 URL 或宿主机文件上传。");
  return [...(content ? [{ type: "text" as const, text: content }] : []), { type: "local_image", path }];
}
export function mergeEvents(previous: NativeEvents["events"], incoming: NativeEvents["events"]): NativeEvents["events"] {
  return [...new Map([...previous, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
}
export interface SdkItemView { id: string; item: Record<string, unknown> }
/** UI snapshots only. Native item IDs and complete original events remain intact. */
export function runItems(events: NativeEvents["events"], requestId: string): SdkItemView[] {
  const items = new Map<string, SdkItemView>();
  for (const envelope of events) {
    if (envelope.requestId !== requestId) continue;
    const event = object(envelope.event);
    if (!["item.started", "item.updated", "item.completed"].includes(text(event.type))) continue;
    const item = object(event.item), id = text(item.id);
    if (id) items.set(id, { id, item });
  }
  return [...items.values()];
}
export function knownThreads(runs: SdkRun[]): string[] { return [...new Set(runs.map(run => run.threadId).filter((id): id is string => !!id))]; }

/** Recover an active submission after reload, including before thread.started. */
export function recoverActiveRequest(threadId: string | null, requestId: string | null, runs: SdkRun[]): string | null {
  return requestId ?? (threadId ? null : runs.find(run => run.status === "running")?.requestId ?? null);
}
