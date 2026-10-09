import type { Project, Session } from '../../protocol/types.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import { mergeRecord } from '../infra/storage/record-merge.js';
import { HttpError } from '../../util/errors.js';

/** A shared, isolated metadata store for tests that restart services. */
export class MemoryWebStateStore implements WebStateStore {
  private projects = new Map<string, Project>();
  private sessions = new Map<string, Session>();
  async init() {}
  async listProjects() { return structuredClone([...this.projects.values()]); }
  async listSessions() { return structuredClone([...this.sessions.values()]); }
  async getProject(id: string) { return structuredClone(this.projects.get(id)); }
  async getSession(id: string) { return structuredClone(this.sessions.get(id)); }
  async saveProject(project: Project, previous?: Project) {
    const latest = this.projects.get(project.id);
    if (previous && !latest) throw new HttpError(409, '项目已删除');
    this.projects.set(project.id, structuredClone(previous ? mergeRecord(previous, project, latest!) : project));
  }
  async saveSession(session: Session, previous?: Session) {
    const latest = this.sessions.get(session.id);
    if (previous && !latest) throw new HttpError(409, '会话已删除');
    this.sessions.set(session.id, structuredClone(previous ? mergeRecord(previous, session, latest!) : session));
  }
  async deleteProject(id: string) { this.projects.delete(id); }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async close() {}
}
