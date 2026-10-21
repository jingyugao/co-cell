import type { Project, Session } from '../../protocol/types.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import { mergeRecord } from '../infra/storage/record-merge.js';
import { HttpError } from '../../util/errors.js';
import type { InputRequestRecord } from '../../protocol/input-request-types.js';

/** A shared, isolated metadata store for tests that restart services. */
export class MemoryWebStateStore implements WebStateStore {
  private projects = new Map<string, Project>();
  private sessions = new Map<string, Session>();
  private inputs = new Map<string, InputRequestRecord>();
  async init() {}
  async listProjects() { return structuredClone([...this.projects.values()]); }
  async listSessions() { return structuredClone([...this.sessions.values()]); }
  async listProjectSessions(projectId: string) { return structuredClone([...this.sessions.values()].filter(session => session.projectId === projectId)); }
  async mutateProject(id: string, mutate: (current: Project) => void) {
    const stored = this.projects.get(id);
    if (!stored) throw new HttpError(409, '项目已删除');
    const project = structuredClone(stored);
    mutate(project);
    if (project.id !== id) throw new Error('Project mutation cannot change its identity');
    this.projects.set(id, structuredClone(project));
    return structuredClone(project);
  }
  async getProject(id: string) { return structuredClone(this.projects.get(id)); }
  async getSession(id: string) { return structuredClone(this.sessions.get(id)); }
  async saveInputRequest(request: InputRequestRecord) { this.inputs.set(request.id, structuredClone(request)); }
  async listInputRequests(sessionId: string) {
    return structuredClone([...this.inputs.values()].filter(request => request.sessionId === sessionId));
  }
  async saveProject(project: Project, previous?: Project) {
    const latest = this.projects.get(project.id);
    if (previous && !latest) throw new HttpError(409, '项目已删除');
    this.projects.set(project.id, structuredClone(previous ? mergeRecord(previous, project, latest!) : project));
  }
  async saveSession(session: Session, previous?: Session) {
    const latest = this.sessions.get(session.id);
    const project = session.projectId ? this.projects.get(session.projectId) : undefined;
    if (project?.removedAt) throw new HttpError(409, '项目已删除，不能保存会话');
    if (!latest && project?.status === 'deleting')
      throw new HttpError(409, '项目正在删除，不能创建会话');
    if (previous && !latest) throw new HttpError(409, '会话已删除');
    this.sessions.set(session.id, structuredClone(previous ? mergeRecord(previous, session, latest!) : session));
  }
  async deleteProject(id: string) { this.projects.delete(id); }
  async deleteSession(id: string) {
    this.sessions.delete(id);
    for (const [key, input] of this.inputs) if (input.sessionId === id) this.inputs.delete(key);
  }
  async close() {}
}
