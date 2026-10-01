import type { ProjectSummary, SandboxInventory, SandboxRecord, SessionSummary } from '../../protocol/types.js';
import type { CellboxSandboxProvider } from '../../packages/sandbox/src/providers/cellbox/index.js';
import type { SandboxInventoryReader } from './inventory.js';
/** Reports only the API client's boxes; listing never resumes a suspended Pod. */
export class CellboxSandboxInventory implements SandboxInventoryReader {
    constructor(private readonly provider: CellboxSandboxProvider) { }
    async read(sessions: SessionSummary[], projects: ProjectSummary[] = []): Promise<SandboxInventory> {
        const rows = await this.provider.listBoxes();
        const byId = new Map(projects.map(project => [project.id, project]));
        const byBox = new Map(projects.filter(project => project.sandbox).map(project => [project.sandbox!.id, project]));
        const associations = new Map<string, NonNullable<SandboxRecord['sessions']>>();
        for (const session of sessions) {
            const id = session.projectId ? byId.get(session.projectId)?.sandbox?.id : session.sandbox?.id;
            if (!id)
                continue;
            const entries = associations.get(id) ?? [];
            entries.push({ id: session.id, title: session.title, status: session.status });
            associations.set(id, entries);
        }
        return { enabled: true, fetchedAt: new Date().toISOString(), sandboxes: rows.filter(row => row.phase !== 'deleted').map(row => {
                const project = byBox.get(row.id), linked = associations.get(row.id) ?? [];
                const paused = row.phase === 'suspended';
                return { id: row.id, template: row.profileId,
                    image: { reference: row.image, id: row.imageId ?? row.image, repoDigests: [] },
                    state: row.phase === 'running' ? 'running' : paused ? 'paused' : 'unknown',
                    cpuCount: 0, memoryMB: 0, startedAt: row.createdAt, endAt: '',
                    sessions: linked, session: linked[0] ?? null,
                    metrics: null, metricsSource: 'cellbox', metricsStatus: paused ? 'paused' : 'unavailable',
                    project: project ? { id: project.id, name: project.name, requirementUrl: project.requirementUrl, sessionCount: project.sessionCount } : null,
                    dangling: !project,
                };
            }) };
    }
}
