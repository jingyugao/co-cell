import type { PageLoadReport } from '../../protocol/page-load-types';
import { isPageLoadResourceUrl } from '../../protocol/page-load-types';

type Milestone = keyof PageLoadReport['milestones'];
type ApiRequest = PageLoadReport['apiRequests'][number];
const endpoint = '/api/diagnostics/page-load';
const windowMs = 120_000;
const apiPath = /^\/api\/(?:config|projects(?:\/[A-Za-z0-9_-]+)?|sessions(?:\/[A-Za-z0-9_-]+(?:\/(?:connection|subagents))?)?)$/;
let state: {
  pageViewId: string;
  path: string;
  sessionId?: string;
  milestones: PageLoadReport['milestones'];
  apiRequests: ApiRequest[];
  failures: PageLoadReport['failures'];
  paint: NonNullable<PageLoadReport['paint']>;
  longTasks?: PageLoadReport['longTasks'];
  ready: boolean;
} | undefined;

const ms = (value: number) => Math.round(Math.max(0, value) * 10) / 10;
const active = () => state && performance.now() < windowMs;

/** Starts independently of React and its stylesheet/module dependencies. */
export function startPageLoadTelemetry() {
  if (!import.meta.env.PROD || state || typeof window === 'undefined' || !/^\/(?:sessions\/[A-Za-z0-9_-]+\/?)?$/.test(location.pathname)) return;
  if (typeof crypto.randomUUID !== 'function') return;
  state = {
    pageViewId: crypto.randomUUID(), path: location.pathname,
    sessionId: /^\/sessions\/([A-Za-z0-9_-]+)/.exec(location.pathname)?.[1],
    milestones: { telemetryStartedMs: ms(performance.now()) }, apiRequests: [], failures: [], paint: {}, ready: false,
  };
  const observe = (type: string, receive: (entries: PerformanceEntry[]) => void) => {
    try {
      const observer = new PerformanceObserver(list => receive(list.getEntries()));
      observer.observe({ type, buffered: true });
      setTimeout(() => observer.disconnect(), windowMs);
      return true;
    } catch { return false; }
  };
  observe('paint', entries => {
    for (const entry of entries) if (entry.name === 'first-contentful-paint') state!.paint.fcpMs = ms(entry.startTime);
  });
  observe('largest-contentful-paint', entries => {
    for (const entry of entries) state!.paint.lcpMs = ms(entry.startTime);
  });
  const longTasks = { count: 0, totalMs: 0, maxMs: 0 };
  if (observe('longtask', entries => {
    for (const entry of entries) {
      longTasks.count++; longTasks.totalMs = ms(longTasks.totalMs + entry.duration);
      longTasks.maxMs = ms(Math.max(longTasks.maxMs, entry.duration));
    }
  })) state.longTasks = longTasks;
  addEventListener('error', (event: Event) => {
    if (event instanceof ErrorEvent) pageLoadFailure('javascript', 'uncaught');
    else pageLoadFailure('resource', event.target instanceof HTMLScriptElement ? 'script' : 'stylesheet');
  }, true);
  addEventListener('unhandledrejection', () => pageLoadFailure('javascript', 'unhandled_rejection'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') reportPageLoad('hidden'); });
  addEventListener('pagehide', () => reportPageLoad('pagehide'));
  for (const delay of [5_000, 15_000, 30_000, 60_000, windowMs]) {
    setTimeout(() => {
      if (!state?.ready || delay === 5_000) reportPageLoad(delay === windowMs ? 'timeout' : 'progress');
    }, Math.max(0, delay - performance.now()));
  }
  reportPageLoad('started');
}

export function setPageLoadSession(id: string | null) {
  if (active() && !state!.sessionId && id) state!.sessionId = id;
}

export function markPageLoad(name: Milestone, sessionId?: string) {
  if (!active() || (sessionId && state!.sessionId !== sessionId) || state!.milestones[name] !== undefined) return;
  state!.milestones[name] = ms(performance.now());
  if (name === 'bootstrapReadyMs') reportPageLoad('progress');
  if (!state!.sessionId && state!.milestones.bootstrapReadyMs !== undefined && state!.milestones.shellPaintMs !== undefined)
    completePageLoad();
}

export function completePageLoad(sessionId?: string) {
  if (!active() || state!.ready || (sessionId && state!.sessionId !== sessionId)) return;
  state!.ready = true;
  state!.milestones.sessionReadyMs = ms(performance.now());
  // Allow paint observers to deliver the frame containing the conversation.
  setTimeout(() => reportPageLoad('ready'), 100);
}

export function pageLoadFailure(stage: string, kind: string, sessionId?: string) {
  if (!active() || (sessionId && state!.sessionId !== sessionId) || state!.failures.length >= 10) return;
  state!.failures.push({ stage, kind, atMs: ms(performance.now()) });
}

export function pageLoadRequest(path: string): { pageViewId: string; record: (request: ApiRequest) => void } | undefined {
  try { startPageLoadTelemetry(); } catch { return; }
  if (!active() || state!.ready || !apiPath.test(path.split('?')[0])) return;
  return {
    pageViewId: state!.pageViewId,
    record: request => { if (active() && state!.apiRequests.length < 10) state!.apiRequests.push(request); },
  };
}

function resources(): PageLoadReport['resources'] {
  return (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .flatMap(entry => {
      try {
        const url = new URL(entry.name);
        // Never send query strings, API/file paths, credentials, or inline data.
        const safeUrl = url.origin + url.pathname;
        if (url.username || url.password || !isPageLoadResourceUrl(safeUrl)) return [];
        return [{ url: safeUrl, type: (entry.initiatorType || 'other').slice(0, 32), startMs: ms(entry.startTime), durationMs: ms(entry.duration),
          transferBytes: entry.transferSize, encodedBytes: entry.encodedBodySize, decodedBytes: entry.decodedBodySize }];
      } catch { return []; }
    }).sort((left, right) => right.durationMs - left.durationMs).slice(0, 10);
}

function reportPageLoad(reason: PageLoadReport['reason']) {
  if (!state || (performance.now() > windowMs + 1000)) return;
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const report: PageLoadReport = {
      version: 1, pageViewId: state.pageViewId, path: state.path, sessionId: state.sessionId,
      timeOrigin: performance.timeOrigin, elapsedMs: ms(performance.now()), reason,
      visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      milestones: { ...state.milestones }, paint: { ...state.paint }, longTasks: state.longTasks && { ...state.longTasks },
      apiRequests: state.apiRequests, failures: state.failures, resources: resources(),
      navigation: nav && {
        type: nav.type, dnsMs: ms(nav.domainLookupEnd - nav.domainLookupStart),
        connectMs: ms(nav.connectEnd - nav.connectStart), tlsMs: nav.secureConnectionStart ? ms(nav.connectEnd - nav.secureConnectionStart) : 0,
        requestStartMs: ms(nav.requestStart), responseStartMs: ms(nav.responseStart), responseEndMs: ms(nav.responseEnd),
        domInteractiveMs: ms(nav.domInteractive), domContentLoadedMs: ms(nav.domContentLoadedEventEnd), loadMs: ms(nav.loadEventEnd),
        transferBytes: nav.transferSize, encodedBytes: nav.encodedBodySize, decodedBytes: nav.decodedBodySize,
      },
    };
    const serialized = JSON.stringify(report);
    if ((reason === 'hidden' || reason === 'pagehide') && navigator.sendBeacon?.(endpoint, new Blob([serialized], { type: 'application/json' }))) return;
    void fetch(endpoint, { method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-CoCell-Page-View': state.pageViewId }, body: serialized }).catch(() => {});
  } catch { /* Diagnostics must never interrupt navigation, rendering, or a turn. */ }
}
