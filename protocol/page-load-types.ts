/** Bounded browser-side timings for one page view. Values are milliseconds unless named otherwise. */
export type PageLoadReason = 'started' | 'progress' | 'ready' | 'hidden' | 'pagehide' | 'timeout';

export type PageLoadMilestones = {
  telemetryStartedMs?: number;
  bootstrapStartedMs?: number;
  bootstrapReadyMs?: number;
  shellPaintMs?: number;
  websocketStartedMs?: number;
  websocketConnectedMs?: number;
  historyReadyMs?: number;
  historyPaintMs?: number;
  sessionReadyMs?: number;
};

export type PageLoadNavigation = {
  type: string;
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  requestStartMs: number;
  responseStartMs: number;
  responseEndMs: number;
  domInteractiveMs: number;
  domContentLoadedMs: number;
  loadMs: number;
  transferBytes: number;
  encodedBytes: number;
  decodedBytes: number;
};

export type PageLoadApiRequest = {
  method: string;
  path: string;
  startMs: number;
  durationMs: number;
  status?: number;
  traceId?: string;
  error?: 'network' | 'protocol' | 'http' | 'abort';
};

export type PageLoadResource = {
  url: string;
  type: string;
  startMs: number;
  durationMs: number;
  transferBytes: number;
  encodedBytes: number;
  decodedBytes: number;
};

export type PageLoadFailure = { stage: string; kind: string; atMs: number };

export type PageLoadReport = {
  pageViewId: string;
  version: 1;
  reason: PageLoadReason;
  path: string;
  sessionId?: string;
  timeOrigin: number;
  elapsedMs: number;
  visibility: 'visible' | 'hidden';
  viewport: { width: number; height: number; devicePixelRatio: number };
  milestones: PageLoadMilestones;
  navigation?: PageLoadNavigation;
  paint?: { fcpMs?: number; lcpMs?: number };
  longTasks?: { count: number; totalMs: number; maxMs: number };
  apiRequests: PageLoadApiRequest[];
  resources: PageLoadResource[];
  failures: PageLoadFailure[];
};

/** Accept only stripped, static browser resource URLs suitable for page timing reports. */
export function isPageLoadResourceUrl(value: string): boolean {
  if (!value || value.length > 300 || value.includes('?') || value.includes('#') || value.includes('\\')) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return false;
  const path = url.pathname;
  if (/^\/assets\/(?:[^/]+\/)*[^/]*-[\da-z_-]{8,}\.(?:m?js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|ico)$/i.test(path)) return true;
  if (/^\/fe\/(?:[^/]+\/)*[^/]+\.(?:tsx?|css)$/i.test(path)) return true;
  if (url.hostname === 'fonts.googleapis.com' && !url.port && path === '/css2') return true;
  if (url.hostname === 'fonts.gstatic.com' && !url.port && /^\/s\/(?:[^/]+\/)*[^/]+\.(?:woff2?|ttf|otf)$/i.test(path)) return true;
  return false;
}
