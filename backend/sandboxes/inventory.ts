import { ApiClient, ConnectionConfig, Sandbox, type ConnectionOpts, type SandboxApiOpts, type SandboxInfo, type SandboxListOpts, type SandboxMetrics, type SandboxMetricsOpts } from 'e2b';
import type { ProjectSummary, SandboxInventory, SandboxRecord, SessionSummary } from '../../protocol/types.js';
import { HttpError } from '../../util/errors.js';

interface InventoryApi {
  list(options: SandboxListOpts): { readonly hasNext: boolean; nextItems(options?: SandboxApiOpts): Promise<SandboxInfo[]> };
  getMetrics(id: string, options: SandboxMetricsOpts): Promise<SandboxMetrics[]>;
}
export interface SandboxInventoryReader {
  read(sessions: SessionSummary[], projects?: ProjectSummary[]): Promise<SandboxInventory>;
  invalidate?(): Promise<void>;
}
interface LiveMetricsReader {
  read(id: string, signal: AbortSignal): Promise<SandboxMetrics | null>;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = (value: Date) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : '';

/** A missing collector can be bypassed only when traffic cannot auto-resume this VM. */
export class EnvdMetricsReader implements LiveMetricsReader {
  constructor(private readonly connection: ConnectionOpts, private readonly request: typeof fetch = fetch) {}

  async read(id: string, signal: AbortSignal): Promise<SandboxMetrics | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    const config = new ConnectionConfig(this.connection);
    const response = await new ApiClient(config).api.GET('/sandboxes/{sandboxID}', {
      params: { path: { sandboxID: id } }, signal, redirect: 'error', fetch: this.request,
    });
    const info = response.data;
    // No no-auto-resume HTTP header exists in E2B. Refuse true AND unknown,
    // including a VM that paused between the inventory and this fresh read.
    if (!info || info.sandboxID !== id || info.state !== 'running' || info.lifecycle?.autoResume !== false) return null;
    const url = new URL(config.getSandboxUrl(id, { sandboxDomain: config.domain, envdPort: 49983 }));
    // Use only configured routing, never a domain or URL supplied in the API payload.
    url.pathname = `${url.pathname.replace(/\/$/, '')}/metrics`;
    url.search = '';
    url.hash = '';
    const headers: Record<string, string> = { 'E2b-Sandbox-Id': id, 'E2b-Sandbox-Port': '49983' };
    if (info.envdAccessToken) headers['X-Access-Token'] = info.envdAccessToken;
    const raw = await this.request(url, { method: 'GET', headers, signal, redirect: 'error' });
    if (!raw.ok) return null;
    const metric = await raw.json() as Record<string, unknown>;
    if (![metric.ts, metric.cpu_used_pct, metric.cpu_count, metric.mem_used, metric.mem_total].every(finite)) return null;
    const sampledAt = new Date(Number(metric.ts) * 1000);
    if (!timestamp(sampledAt)) return null;
    return {
      timestamp: sampledAt, cpuUsedPct: Number(metric.cpu_used_pct), cpuCount: Number(metric.cpu_count),
      memUsed: Number(metric.mem_used), memTotal: Number(metric.mem_total),
      memCache: finite(metric.mem_cache) ? metric.mem_cache : 0,
      diskUsed: finite(metric.disk_used) ? metric.disk_used : NaN,
      diskTotal: finite(metric.disk_total) ? metric.disk_total : NaN,
    };
  }
}

function applyMetrics(sandbox: SandboxRecord, latest: SandboxMetrics, source: 'e2b' | 'envd') {
  sandbox.metrics = {
    timestamp: timestamp(latest.timestamp), cpuUsedPct: latest.cpuUsedPct,
    memUsedBytes: latest.memUsed, memTotalBytes: latest.memTotal,
    diskUsedBytes: finite(latest.diskUsed) ? latest.diskUsed : null,
    diskTotalBytes: finite(latest.diskTotal) ? latest.diskTotal : null,
  };
  sandbox.metricsStatus = 'available';
  sandbox.metricsSource = source;
  sandbox.metricsMessage = source === 'envd' ? '沙箱实时采样' : undefined;
  if (Date.now() - latest.timestamp.getTime() > 60_000) sandbox.metricsMessage = '最近一次采样已超过 60 秒，请以采样时间为准';
}

/** Read-only inventory and guarded live sampling; viewing the page must not wake paused VMs. */
export class E2BSandboxInventory implements SandboxInventoryReader {
  private cached?: { inventory: SandboxInventory; platformSandboxIds: Set<string> };
  private refresh?: Promise<{ inventory: SandboxInventory; platformSandboxIds: Set<string> }>;

  constructor(
    private readonly connection?: ConnectionOpts,
    private readonly api: InventoryApi = Sandbox,
    private readonly liveMetrics: LiveMetricsReader | undefined = connection && api === Sandbox ? new EnvdMetricsReader(connection) : undefined,
  ) {}

  async invalidate() {
    await this.refresh?.catch(() => {});
    this.cached = undefined;
  }

  async read(sessions: SessionSummary[], projects: ProjectSummary[] = []): Promise<SandboxInventory> {
    if (!this.connection) return { enabled: false, fetchedAt: new Date().toISOString(), sandboxes: [] };
    let snapshot = this.cached;
    if (!snapshot || Date.now() - Date.parse(snapshot.inventory.fetchedAt) >= 5_000) {
      if (!this.refresh) {
        this.refresh = this.fetch().then(result => { this.cached = result; return result; }).finally(() => { this.refresh = undefined; });
      }
      snapshot = await this.refresh;
    }
    const { inventory, platformSandboxIds } = snapshot;
    // Derive ownership from our persisted mapping, never from untrusted E2B metadata.
    const owners = new Map(projects.filter(p => p.executionMode === 'e2b' && p.sandbox).map(p => [p.sandbox!.id, p]));
    const reserved = new Set(projects.flatMap(project => project.sandboxUpgrade && project.sandboxUpgrade.phase !== 'failed' && project.sandboxUpgrade.target
      ? [project.sandboxUpgrade.target.id] : []));
    const metadata = new Map([...owners.values()].map(project => [project.sandbox!.id, project.sandbox!]));
    const byProject = new Map(projects.map(p => [p.id, p]));
    const associations = new Map<string, NonNullable<SandboxRecord['sessions']>>();
    const legacyOwned = new Set<string>();
    for (const session of sessions) {
      if (session.settings.executionMode !== 'e2b') continue;
      const sandboxId = session.projectId ? byProject.get(session.projectId)?.sandbox?.id : session.sandbox?.id;
      if (!sandboxId) continue;
      if (!session.projectId) legacyOwned.add(sandboxId);
      if (!metadata.has(sandboxId) && session.sandbox) metadata.set(sandboxId, session.sandbox);
      const associated = associations.get(sandboxId) ?? [];
      associated.push({ id: session.id, title: session.title, status: session.status });
      associations.set(sandboxId, associated);
    }
    const records = new Map(inventory.sandboxes.map(sandbox => [sandbox.id, sandbox]));
    // Archived VMs may no longer exist in E2B; keep their persisted archives visible.
    for (const sandbox of metadata.values()) {
      if (records.has(sandbox.id) || !['archiving', 'archived', 'restoring'].includes(sandbox.status)) continue;
      records.set(sandbox.id, {
        id: sandbox.id, template: sandbox.template, state: 'unknown', cpuCount: 0, memoryMB: 0,
        startedAt: '', endAt: '', session: null, metrics: null, metricsStatus: 'unavailable',
      });
    }
    return {
      ...inventory,
      sandboxes: [...records.values()].map(sandbox => {
        const associated = associations.get(sandbox.id) ?? [];
        const project = owners.get(sandbox.id);
        const saved = metadata.get(sandbox.id);
        const archivedState = saved?.status === 'archived' || saved?.status === 'archiving' || saved?.status === 'restoring' ? saved.status : undefined;
        return {
          ...sandbox, sessions: associated, session: associated[0] ?? null,
          state: archivedState ?? sandbox.state,
          pausedAt: saved?.pausedAt, archive: saved?.archive,
          ...(archivedState ? {
            metrics: null, metricsStatus: 'unavailable' as const, metricsSource: undefined,
            metricsMessage: archivedState === 'archived' ? '文件已压缩保存，使用时自动恢复' : archivedState === 'archiving' ? '正在压缩并保存文件' : '正在从归档恢复文件',
          } : {}),
          project: project ? { id: project.id, name: project.name, requirementUrl: project.requirementUrl, sessionCount: project.sessionCount } : null,
          dangling: platformSandboxIds.has(sandbox.id) && !project && !legacyOwned.has(sandbox.id) && !reserved.has(sandbox.id),
        };
      }),
    };
  }

  private async fetch(): Promise<{ inventory: SandboxInventory; platformSandboxIds: Set<string> }> {
    const deadline = AbortSignal.timeout(15_000);
    const info = new Map<string, SandboxInfo>();
    try {
      const pages = this.api.list({ ...this.connection, requestTimeoutMs: 10_000, query: { state: ['running', 'paused'] }, limit: 100 });
      while (pages.hasNext) {
        deadline.throwIfAborted();
        for (const sandbox of await pages.nextItems({ signal: deadline, requestTimeoutMs: 10_000 })) info.set(sandbox.sandboxId, sandbox);
      }
    } catch {
      // SDK errors may contain upstream response bodies, addresses or credentials.
      throw new HttpError(503, '无法读取 E2B 沙箱列表，请检查 E2B 服务及访问配置后重试');
    }
    const platformSandboxIds = new Set([...info.values()].filter(sandbox => sandbox.metadata?.app === 'codex-web').map(sandbox => sandbox.sandboxId));
    const sandboxes: SandboxRecord[] = [...info.values()].map(sandbox => ({
      id: sandbox.sandboxId,
      template: sandbox.name || sandbox.templateId,
      state: sandbox.state === 'running' || sandbox.state === 'paused' ? sandbox.state : 'unknown',
      cpuCount: finite(sandbox.cpuCount) ? sandbox.cpuCount : 0,
      memoryMB: finite(sandbox.memoryMB) ? sandbox.memoryMB : 0,
      startedAt: timestamp(sandbox.startedAt),
      endAt: timestamp(sandbox.endAt),
      session: null,
      metrics: null,
      metricsStatus: sandbox.state === 'paused' ? 'paused' : 'unavailable',
    }));
    let next = 0;
    const worker = async () => {
      while (next < sandboxes.length) {
        const sandbox = sandboxes[next++];
        if (sandbox.state !== 'running') continue;
        try {
          deadline.throwIfAborted();
          // Let E2B derive both bounds from stored samples; a partial range can
          // be invalid when a self-hosted collector has not ingested metrics yet.
          const samples = await this.api.getMetrics(sandbox.id, {
            ...this.connection, requestTimeoutMs: 4_000,
            signal: AbortSignal.any([deadline, AbortSignal.timeout(4_000)]),
          });
          const latest = samples.filter(m => timestamp(m.timestamp) && finite(m.cpuUsedPct) && finite(m.memUsed) && finite(m.memTotal))
            .reduce<SandboxMetrics | undefined>((last, sample) => !last || sample.timestamp > last.timestamp ? sample : last, undefined);
          if (latest) {
            applyMetrics(sandbox, latest, 'e2b');
          } else {
            sandbox.metricsStatus = samples.length ? 'unavailable' : 'pending';
            sandbox.metricsMessage = samples.length ? 'E2B 返回的指标不完整' : 'E2B 暂未返回资源采样';
          }
        } catch {
          sandbox.metricsStatus = 'unavailable';
          sandbox.metricsMessage = '暂时无法读取资源指标';
        }
        if (this.liveMetrics && (!sandbox.metrics || Date.now() - Date.parse(sandbox.metrics.timestamp) > 60_000)) {
          try {
            deadline.throwIfAborted();
            const current = await this.liveMetrics.read(sandbox.id, AbortSignal.any([deadline, AbortSignal.timeout(4_000)]));
            if (current) applyMetrics(sandbox, current, 'envd');
          } catch { /* Keep the management API result; fallback errors may include credentials. */ }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, sandboxes.length) }, worker));
    sandboxes.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
    return { inventory: { enabled: true, fetchedAt: new Date().toISOString(), sandboxes }, platformSandboxIds };
  }
}
