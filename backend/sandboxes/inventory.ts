import type { ProjectSummary, SandboxInventory, SandboxRecord, SessionSummary } from '../../protocol/types.js';
import { DockerSandboxClient } from '../../packages/docker-sandbox/src/index.js';

export interface SandboxInventoryReader {
  read(sessions: SessionSummary[], projects?: ProjectSummary[]): Promise<SandboxInventory>;
  invalidate?(): Promise<void>;
}

export class DockerSandboxInventory implements SandboxInventoryReader {
  constructor(private readonly client: DockerSandboxClient) {}
  async read(sessions: SessionSummary[], projects: ProjectSummary[] = []): Promise<SandboxInventory> {
    const rows = await this.client.list();
    const projectsBySandbox = new Map(projects.filter(project => project.sandbox).map(project => [project.sandbox!.id, project]));
    const projectsById = new Map(projects.map(project => [project.id, project]));
    const associations = new Map<string, NonNullable<SandboxRecord['sessions']>>();
    for (const session of sessions) {
      const id = session.projectId ? projectsById.get(session.projectId)?.sandbox?.id : session.sandbox?.id;
      if (!id) continue;
      const list = associations.get(id) ?? [];
      list.push({ id: session.id, title: session.title, status: session.status });
      associations.set(id, list);
    }
    return { enabled: true, fetchedAt: new Date().toISOString(), sandboxes: rows.map(row => {
      const project = projectsBySandbox.get(row.id);
      const associated = associations.get(row.id) ?? [];
      return { id: row.id, template: row.image, state: row.status === 'ready' ? 'running' : row.status === 'paused' ? 'paused' : 'unknown',
        cpuCount: 0, memoryMB: 0, startedAt: row.createdAt, endAt: '', session: associated[0] ?? null, sessions: associated,
        metrics: null, metricsStatus: row.status === 'paused' ? 'paused' : 'unavailable', metricsSource: 'docker',
        project: project ? { id: project.id, name: project.name, requirementUrl: project.requirementUrl, sessionCount: project.sessionCount } : null,
        dangling: !project };
    }) };
  }
}
