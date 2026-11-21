import { HttpError } from '../../util/errors.js';
import { needsWorker, terminal, type StoredRun, type WorkflowStore } from '../workflows/store.js';

export class MemoryWorkflowStore implements WorkflowStore {
  private runs = new Map<string, StoredRun>();
  async get(id: string) {
    return structuredClone(this.runs.get(id));
  }
  async atRevision(id: string, revision: number) {
    const r = this.runs.get(id);
    return Boolean(r && !terminal(r) && r.revision === revision);
  }
  async list(projectId?: string) {
    return [...this.runs.values()]
      .filter((r) => !projectId || projectId === r.projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100)
      .map(({ id, projectId, requirement, status, revision, updatedAt }) => ({
        id,
        projectId,
        requirement,
        status,
        revision,
        updatedAt,
      }));
  }
  async pending() {
    return [...this.runs.values()].filter(needsWorker).map((r) => r.id);
  }
  async insert(r: StoredRun) {
    if (
      this.runs.has(r.id) ||
      [...this.runs.values()].some((old) => !terminal(old) && old.projectId === r.projectId)
    )
      throw new HttpError(409, '项目已有工作流');
    this.runs.set(r.id, structuredClone(r));
  }
  async save(r: StoredRun, expected: number) {
    if (this.runs.get(r.id)?.revision !== expected) throw new HttpError(409, '工作台状态已变化，请刷新后重试');
    this.runs.set(r.id, structuredClone(r));
  }
}
