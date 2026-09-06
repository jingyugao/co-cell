import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NativeEvent, SdkRun } from "../src/contracts/native.js";
import { App, ItemView, RunView } from "../web/src/App.js";
import { api, knownThreads, mergeEvents, recoverActiveRequest, runItems, sdkInput, workspaceRoute, workspaceUrl } from "../web/src/sdk-api.js";

afterEach(() => vi.unstubAllGlobals());
function event(seq: number, item: Record<string, unknown>, type = "item.completed", requestId = "request-1"): NativeEvent {
  return { seq, requestId, event: { type, item } } as NativeEvent;
}
const run: SdkRun = { requestId: "request-1", threadId: "native-thread-1", input: "  original\nmessage  ", createdAt: "2026-09-06T01:00:00Z", status: "completed" };

describe("SDK web data and navigation", () => {
  it("uses new workspace routes without importing legacy multi-agent or native RPC navigation", () => {
    expect(workspaceRoute("/workspaces/abc")).toBe("abc");
    expect(workspaceRoute("/workspaces/abc/")).toBe("abc");
    expect(workspaceUrl("work/space")).toBe("/workspaces/work%2Fspace");
    expect(workspaceRoute(workspaceUrl("work/space"))).toBe("work/space");
    for (const path of ["/", "/codex/id", "/agent", "/workspaces/%broken"]) expect(workspaceRoute(path)).toBeNull();
  });

  it("preserves text verbatim and uses only SDK local_image for sandbox paths", () => {
    expect(sdkInput("  exact\nmessage  ", "")).toBe("  exact\nmessage  ");
    expect(sdkInput(" hello ", "/home/user/projects/image.png")).toEqual([{ type: "text", text: " hello " }, { type: "local_image", path: "/home/user/projects/image.png" }]);
    expect(sdkInput("", "/tmp/image.png")).toEqual([{ type: "local_image", path: "/tmp/image.png" }]);
    expect(() => sdkInput("", "")).toThrow();
    expect(() => sdkInput("hello", "https://example.test/image.png")).toThrow("沙箱内");
    expect(() => sdkInput("hello", "relative.png")).toThrow("沙箱内");
  });

  it("preserves native item IDs and unknown fields, scopes repeated IDs by run, and replaces snapshots", () => {
    const first = event(1, { id: "item_0", type: "agent_message", text: "partial", newField: true }, "item.started");
    const last = event(2, { id: "item_0", type: "agent_message", text: "complete", newField: true });
    const other = event(3, { id: "item_0", type: "agent_message", text: "other request" }, "item.completed", "request-2");
    const original = JSON.stringify([first, last, other]);
    expect(runItems([first, last, other], "request-1")).toEqual([{ id: "item_0", item: { id: "item_0", type: "agent_message", text: "complete", newField: true } }]);
    expect(JSON.stringify([first, last, other])).toBe(original);
    expect(mergeEvents([first, last], [last, other])).toEqual([first, last, other]);
  });

  it("derives only known native threads from run history", () => {
    expect(knownThreads([run, { ...run, requestId: "another" }, { ...run, requestId: "pending", threadId: null }])).toEqual(["native-thread-1"]);
  });

  it("recovers the active request after reload without replacing an idle new conversation or selected session", () => {
    const active: SdkRun = { ...run, status: "running" };
    const recovered = recoverActiveRequest(null, null, [active]);
    expect(recovered).toBe(active.requestId);
    expect([active].find(value => value.requestId === recovered)?.threadId).toBe("native-thread-1");
    expect(recoverActiveRequest(null, null, [run])).toBeNull();
    expect(recoverActiveRequest("selected-thread", null, [active])).toBeNull();
    expect(recoverActiveRequest(null, "own-request", [active])).toBe("own-request");
  });

  it("can show recovered active input and native events before a thread ID is available", () => {
    const active: SdkRun = { ...run, status: "running", threadId: null };
    const recovered = recoverActiveRequest(null, null, [active]);
    const visible = [active].filter(value => value.requestId === recovered);
    expect(visible).toEqual([active]);
    const html = renderToStaticMarkup(createElement(RunView, { run: visible[0]!, events: [event(1, { id: "item_0", type: "agent_message", text: "working" })] }));
    expect(html).toContain("original");
    expect(html).toContain("working");
    expect(html).toContain("等待 SDK thread.started");
  });
});

describe("SDK web rendering", () => {
  it("renders the SDK disclaimer and registration without side effects on initial render", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("官方 Codex SDK");
    expect(html).toContain("不是完整 Codex UI");
    expect(html).toContain("只登记，不自动创建沙箱或启动任务");
    expect(html).not.toMatch(/app-server|Coordinator|Agent Specs|技术方案通过|turn\/steer|批准本次命令/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders complete SDK todo lists and keeps raw item JSON available", () => {
    const html = renderToStaticMarkup(createElement(ItemView, { value: { id: "item_4", item: { id: "item_4", type: "todo_list", items: [{ text: "Read repository", completed: true }, { text: "Write test", completed: false }] } } }));
    expect(html).toContain("✓ Read repository");
    expect(html).toContain("○ Write test");
    expect(html).toContain("SDK 原始数据");
    expect(html).toContain("item_4");
  });

  it("shows unknown items and events as inert raw text without inventing IDs", () => {
    const unknown = event(1, { id: "item_unknown", type: "future_tool", value: "<script>bad</script>" });
    const html = renderToStaticMarkup(createElement(RunView, { run, events: [unknown, { seq: 2, requestId: run.requestId, event: { type: "future.event", payload: "keep me" } } as unknown as NativeEvent] }));
    expect(html).toContain("item_unknown");
    expect(html).toContain("future.event");
    expect(html).toContain("keep me");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("传输请求 ID");
    expect(html).toContain("原生 Thread ID");
    expect(html).toContain(run.input);
  });
});

describe("SDK web API", () => {
  it("uses official SDK run inputs with a separate request ID and no hidden task injection", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => run }); vi.stubGlobal("fetch", fetch);
    await api.run("workspace/1", "transport-id", "  exact text  ");
    expect(fetch).toHaveBeenLastCalledWith("/api/workspaces/workspace%2F1/runs", expect.objectContaining({ method: "POST", body: JSON.stringify({ requestId: "transport-id", input: "  exact text  " }) }));
    await api.run("workspace/1", "transport-id-2", "follow-up", "native-thread-id");
    expect(fetch).toHaveBeenLastCalledWith("/api/workspaces/workspace%2F1/runs", expect.objectContaining({ body: JSON.stringify({ requestId: "transport-id-2", input: "follow-up", threadId: "native-thread-id" }) }));
    await api.interrupt("workspace/1", "request/1");
    expect(fetch).toHaveBeenLastCalledWith("/api/workspaces/workspace%2F1/runs/request%2F1/interrupt", expect.objectContaining({ method: "POST", body: "{}" }));
  });

  it("separates registering/opening a workspace from starting a model run and supports read cancellation", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }); vi.stubGlobal("fetch", fetch);
    await api.create("Demo", "https://project.feishu.cn/project/story/detail/1");
    expect(fetch).toHaveBeenLastCalledWith("/api/workspaces", expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "Demo", sourceUrl: "https://project.feishu.cn/project/story/detail/1" }) }));
    await api.open("workspace-1");
    expect(fetch).toHaveBeenLastCalledWith("/api/workspaces/workspace-1/open", expect.objectContaining({ method: "POST", body: "{}" }));
    const controller = new AbortController(); await api.events("workspace-1", 42, controller.signal);
    expect(fetch).toHaveBeenLastCalledWith("/api/workspaces/workspace-1/events?after=42", expect.objectContaining({ method: "GET", signal: controller.signal }));
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/runs"))).toBe(false);
  });

  it("surfaces failures and never retries ambiguous writes", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection lost")); vi.stubGlobal("fetch", fetch);
    await expect(api.run("workspace", "request", "message")).rejects.toThrow("connection lost");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { message: "SDK run is active" } }) });
    await expect(api.run("workspace", "new-request", "message")).rejects.toThrow("SDK run is active");
  });
});
