import type { Project, Session } from '../../protocol/types.js';
import type { WebStateStore } from '../infra/storage/web-state.js';

/** A shared, isolated metadata store for tests that restart services. */
export class MemoryWebStateStore implements WebStateStore {
  private projects = new Map<string, Project>();
  private sessions = new Map<string, Session>();
  async init() {}
  async listProjects() { return structuredClone([...this.projects.values()]); }
  async listSessions() { return structuredClone([...this.sessions.values()]); }
  async saveProject(project: Project) { this.projects.set(project.id, structuredClone(project)); }
  async saveSession(session: Session) { this.sessions.set(session.id, structuredClone(session)); }
  async deleteProject(id: string) { this.projects.delete(id); }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async close() {}
}
