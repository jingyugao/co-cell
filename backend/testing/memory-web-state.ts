import type { Project, Session } from '../../protocol/types.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import { mergeRecord } from '../infra/storage/record-merge.js';
import { HttpError } from '../../util/errors.js';
import type { InputRequestRecord } from '../../protocol/input-request-types.js';
import { applyNativeEvent, type NativeBusinessEvent } from '../sessions/native-events.js';
import type { AppNotification } from '../../protocol/notification-types.js';

/** A shared, isolated metadata store for tests that restart services. */
export class MemoryWebStateStore implements WebStateStore {
  private projects = new Map<string, Project>();
  private sessions = new Map<string, Session>();
  private inputs = new Map<string, InputRequestRecord>();
  private nativeEvents = new Map<string, NativeBusinessEvent>();
  readonly nativeNotifications = new Map<string, AppNotification>();
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
  async consumeNativeEvents(events: NativeBusinessEvent[]) {
    if (!events.length) return undefined;
    const first = events[0];
    if (events.some(event => event.sessionId !== first.sessionId || event.threadId !== first.threadId))
      throw new Error('A native transaction must belong to one session and thread');
    const stored = this.sessions.get(first.sessionId);
    if (!stored || stored.threadId !== first.threadId || stored.settings.executionMode !== 'sandbox') return undefined;
    const project = stored.projectId ? this.projects.get(stored.projectId) : undefined;
    if (project?.removedAt || project?.status === 'deleting') return undefined;
    let session = structuredClone(stored);
    const inputs = new Map(this.inputs), observed = new Map(this.nativeEvents), notifications = new Map(this.nativeNotifications);
    for (const event of events) {
      if (observed.has(event.key)) continue;
      const usages = [...observed.values()].filter(value => value.kind === 'usage'
        && value.sessionId === first.sessionId && value.threadId === first.threadId && value.turnId === event.turnId);
      const usageObservedAt = usages.map(value => value.payload.usage!.sourceAt).filter((value): value is string => !!value).sort().at(-1);
      const usageTotalTokens = usages.map(value => value.payload.usage!.totalTokens).filter((value): value is number => value !== undefined)
        .reduce<number | undefined>((max, value) => max === undefined ? value : Math.max(max, value), undefined);
      const result = applyNativeEvent(session, event, { projectName: project?.name, usageObservedAt, usageTotalTokens,
        inputExists: !!event.payload.input && inputs.has(event.payload.input.id) });
      session = result.session;
      if (result.input) inputs.set(result.input.id, { ...result.input, turnId: result.turn.id });
      if (result.notification) notifications.set(result.notification.id, result.notification);
      observed.set(event.key, structuredClone(event));
    }
    this.sessions.set(session.id, structuredClone(session));
    this.inputs = inputs;
    this.nativeEvents = observed;
    this.nativeNotifications.clear();
    for (const [key, value] of notifications) this.nativeNotifications.set(key, value);
    return structuredClone(session);
  }
  async listInputRequests(sessionId: string) {
    return structuredClone([...this.inputs.values()].filter(request => request.sessionId === sessionId));
  }
  async saveProject(project: Project, previous?: Project) {
    const latest = this.projects.get(project.id);
    if (previous && !latest) throw new HttpError(409, '项目已删除');
    this.projects.set(project.id, structuredClone(previous ? mergeRecord(previous, project, latest!) : project));
  }
  async saveSession(session: Session, previous?: Session, metadataOnly = false) {
    const latest = this.sessions.get(session.id);
    const project = session.projectId ? this.projects.get(session.projectId) : undefined;
    if (project?.removedAt) throw new HttpError(409, '项目已删除，不能保存会话');
    if (!latest && project?.status === 'deleting')
      throw new HttpError(409, '项目正在删除，不能创建会话');
    if (previous && !latest) throw new HttpError(409, '会话已删除');
    const next = previous ? mergeRecord(previous, session, latest!) : session;
    this.sessions.set(session.id, structuredClone(metadataOnly && latest
      ? { ...next, status: latest.status, turnCount: latest.turnCount, contextUsage: latest.contextUsage, turns: latest.turns } : next));
  }
  async deleteProject(id: string) { this.projects.delete(id); }
  async deleteSession(id: string) {
    this.sessions.delete(id);
    for (const [key, input] of this.inputs) if (input.sessionId === id) this.inputs.delete(key);
    for (const [key, event] of this.nativeEvents) if (event.sessionId === id) this.nativeEvents.delete(key);
  }
  async close() {}
}
