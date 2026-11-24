import { anonymousClaudeToken, anthropicBaseUrl, type ModelSelection } from '../models/service.js';
import type { Session, Turn } from '../../protocol/types.js';
import { HttpError, redactCredentials } from '../../util/errors.js';

/** Reserved for the project-local ACP host. Browser previews must never route to this port. */
export const CLAUDE_HOST_PORT = 4501;
type ServiceAccess = (box: string, port: number) => Promise<{url: string; headers: Record<string, string>}>;
interface Snapshot { threadId: string | null; turns: Turn[] }

export class ClaudeBoxClient {
  constructor(private readonly access: ServiceAccess, private readonly prepareHooks?: (session: Session) => Promise<void>) {}

  private async request(box: string, path: string, options: RequestInit = {}, apiKey?: string): Promise<Response> {
    const timeout = AbortSignal.timeout(20_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const endpoint = await this.access(box, CLAUDE_HOST_PORT);
    const headers = new Headers(endpoint.headers);
    if (options.body) headers.set('Content-Type', 'application/json');
    new Headers(options.headers).forEach((value, name) => headers.set(name, value));
    let response: Response;
    try { response = await fetch(endpoint.url.replace(/\/$/, '') + path, { ...options, headers, signal, redirect: 'error' }); }
    catch { throw new HttpError(503, '无法连接 Claude 会话宿主，请检查 Sandbox 镜像及运行状态'); }
    if (response.ok || response.status === 304) return response;
    const body = await response.json().catch(() => ({})) as {error?: unknown};
    let detail = typeof body.error === 'string' ? body.error : '';
    if (apiKey) detail = detail.replaceAll(apiKey, '[REDACTED]');
    throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502,
      detail ? redactCredentials(detail).slice(0, 320) : 'Claude 会话宿主不可用，请检查 Sandbox 镜像');
  }

  async health(box: string): Promise<{ active: boolean; supportsEffort?: boolean }> {
    const data = await (await this.request(box, '/health')).json();
    if (data.protocol !== 'cocell-claude-acp-v1' || typeof data.active !== 'boolean')
      throw new HttpError(503, '当前 Sandbox 镜像不支持 Claude Code');
    return data;
  }

  async snapshot(box: string, session: string, etag?: string): Promise<{snapshot: Snapshot; etag?: string} | undefined> {
    const response = await this.request(box, '/sessions/' + encodeURIComponent(session),
      etag ? { headers: { 'If-None-Match': etag } } : {});
    if (response.status === 304) return undefined;
    const snapshot = await response.json();
    if (!Array.isArray(snapshot.turns)) throw new HttpError(502, 'Claude 会话快照无效');
    return { snapshot, etag: response.headers.get('etag') ?? undefined };
  }

  async verify(box: string, session: string) {
    const response = await this.request(box, '/sessions/' + encodeURIComponent(session) + '/verify');
    if ((await response.json()).verified !== true) throw new HttpError(502, '恢复后的 Claude 会话无法校验');
  }

  async reserve(box: string, session: string) {
    await this.health(box);
    await (await this.request(box, '/sessions/' + encodeURIComponent(session), { method: 'PUT' })).arrayBuffer();
  }

  private async sendModelRequest(box: string, session: Session, action: 'turns' | 'answers' | 'reconcile',
    selected: ModelSelection, input: Record<string, unknown>) {
    await this.prepareHooks?.(session);
    const effort = session.settings.claudeEffort;
    if (effort && effort !== 'default' && (await this.health(box)).supportsEffort !== true)
      throw new HttpError(409, '当前 Sandbox 镜像不支持设置 Claude 推理强度，请选择默认或升级镜像');
    const env = { ANTHROPIC_BASE_URL: anthropicBaseUrl(selected.endpoint), ANTHROPIC_MODEL: selected.model,
      ...(selected.claudeModelAliases?.haiku ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: selected.claudeModelAliases.haiku } : {}),
      ...(selected.claudeModelAliases?.sonnet ? { ANTHROPIC_DEFAULT_SONNET_MODEL: selected.claudeModelAliases.sonnet } : {}),
      ...(selected.claudeModelAliases?.opus ? { ANTHROPIC_DEFAULT_OPUS_MODEL: selected.claudeModelAliases.opus } : {}),
      ...(selected.apiKey && selected.authMode !== 'bearer' ? { ANTHROPIC_API_KEY: selected.apiKey }
        : { ANTHROPIC_AUTH_TOKEN: selected.apiKey || anonymousClaudeToken }) };
    return this.request(box, '/sessions/' + encodeURIComponent(session.id) + '/' + action, { method: 'POST',
      body: JSON.stringify({ ...input, cwd: session.settings.workingDirectory, model: selected.model, effort, env }) }, selected.apiKey);
  }

  async submit(box: string, session: Session, selected: ModelSelection, id: string, prompt: string, images: string[]) {
    const result = await (await this.sendModelRequest(box, session, 'turns', selected, { id, prompt, images })).json();
    if (!result.turnId || typeof result.turnId !== 'string') throw new HttpError(502, 'Claude 输入接收状态未知，请刷新会话');
    return result.turnId as string;
  }

  async answer(box: string, session: Session, selected: ModelSelection, turnId: string, requestId: string, answers: string[]) {
    await (await this.sendModelRequest(box, session, 'answers', selected, { ownerTurnId: turnId, requestId, answers })).arrayBuffer();
  }

  async reconcile(box: string, session: Session, selected: ModelSelection) {
    await (await this.sendModelRequest(box, session, 'reconcile', selected, {})).arrayBuffer();
  }

  async stop(box: string, session: string) {
    await (await this.request(box, '/sessions/' + encodeURIComponent(session) + '/stop', { method: 'POST' })).arrayBuffer();
  }
}
