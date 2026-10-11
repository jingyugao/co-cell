import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Session } from '../../protocol/types.js';
import type { ThreadOptions } from '../../packages/agentcore/src/index.mjs';
import type { SecretCrypto } from '../secrets/crypto.js';
import type { ModelService } from './service.js';
import type { ModelRuntimeRepository } from './runtime-repository.js';

const PREFIX = '/api/model-runtime';
const TOKEN_LIFETIME = 7 * 24 * 60 * 60 * 1000;
interface Grant { endpoint: string; apiKey: string; expiresAt: number }

/** Upstream keys stay on the web server. Each turn receives an encrypted,
 * session grant. A durable configuration snapshot is replaced before each turn,
 * so channel edits cannot reroute a running turn or affect another session. */
export class ModelGateway {
  constructor(private models: ModelService, private crypto: SecretCrypto, private origin: string, private repository: ModelRuntimeRepository, private disableLegacyRetries = false) {}

  async threadOptions(session: Pick<Session, 'id' | 'settings'>): Promise<Pick<ThreadOptions, 'model' | 'modelProvider' | 'providerConfig'>> {
    const selected = await this.models.selection(session.settings);
    if (!selected) return {};
    const grant: Grant = { endpoint: selected.endpoint, apiKey: selected.apiKey, expiresAt: Date.now() + TOKEN_LIFETIME };
    await this.repository.save(session.id, this.crypto.seal(session.id, 'model-runtime-snapshot-v1', Buffer.from(JSON.stringify(grant))));
    const token = this.crypto.seal('model-runtime-access', '1', Buffer.from(session.id));
    const provider = `cocell_session_${session.id.replaceAll('-', '_')}`;
    return { model: selected.model, modelProvider: provider, providerConfig: {
      [`model_providers.${provider}`]: { name: provider, base_url: `${this.origin.replace(/\/$/, '')}${PREFIX}/${session.id}/v1`,
        wire_api: 'responses', supports_websockets: false, experimental_bearer_token: token,
        ...(selected.channelId === 'legacy-default' && this.disableLegacyRetries ? { request_max_retries: 0, stream_max_retries: 0 } : {}) },
    } };
  }

  private async grant(request: Request, sessionId: string): Promise<Grant | undefined> {
    const authorization = request.headers.get('authorization') ?? '';
    if (!authorization.startsWith('Bearer ') || authorization.length > 16000) return;
    try {
      const tokenSession = this.crypto.open('model-runtime-access', '1', authorization.slice(7)).toString();
      if (tokenSession !== sessionId) return;
      const sealed = await this.repository.load(sessionId);
      if (!sealed) return;
      const value = JSON.parse(this.crypto.open(sessionId, 'model-runtime-snapshot-v1', sealed).toString()) as Grant;
      if (typeof value.endpoint !== 'string' || typeof value.apiKey !== 'string' || !Number.isFinite(value.expiresAt)
        || value.expiresAt <= Date.now()) return;
      return value;
    } catch { return; }
  }

  async forward(request: Request, sessionId: string, path: string): Promise<Response> {
    const fail = (status: number, message: string) => Response.json({ error: { message, type: 'model_channel_error' } },
      { status, headers: { 'Cache-Control': 'no-store' } });
    const grant = await this.grant(request, sessionId);
    if (!grant) return fail(401, '模型请求授权无效或已过期，请发起新的轮次');
    if (request.headers.has('origin')) return fail(403, '模型运行接口仅供服务端调用');
    if (!(request.method === 'POST' && ['responses', 'responses/compact'].includes(path))
      && !(request.method === 'GET' && path === 'models')) return fail(404, '模型运行接口不存在');
    const headers = new Headers({ accept: request.headers.get('accept') ?? 'application/json', 'content-type': 'application/json' });
    if (grant.apiKey) headers.set('authorization', `Bearer ${grant.apiKey}`);
    for (const name of ['content-encoding', 'user-agent', 'originator', 'x-client-request-id', 'openai-beta', 'x-codex-turn-state', 'x-codex-turn-metadata', 'x-codex-parent-thread-id', 'session_id']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const connection = new AbortController();
    const timer = setTimeout(() => connection.abort(), 60_000);
    timer.unref();
    try {
      const upstream = await fetch(`${grant.endpoint.replace(/\/+$/, '')}/${path}`, {
        method: request.method, headers, ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}),
        redirect: 'manual', signal: AbortSignal.any([request.signal, connection.signal]),
      });
      clearTimeout(timer);
      if (!upstream.ok) {
        // Never expose upstream error bodies: gateways can echo credentials or URLs.
        await upstream.body?.cancel();
        const response = fail(upstream.status >= 400 ? upstream.status : 502, `模型渠道请求失败（HTTP ${upstream.status}）`);
        const retryAfter = upstream.headers.get('retry-after');
        if (retryAfter) response.headers.set('retry-after', retryAfter);
        return response;
      }
      const responseHeaders = new Headers({ 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      for (const name of ['content-type', 'x-request-id', 'x-codex-turn-state']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch { return fail(502, '模型渠道连接失败，请检查渠道配置或稍后重试'); }
    finally { clearTimeout(timer); }
  }
}

/** Installed before operator authentication: this route has its own scoped grant,
 * and must never accept an operator token as model authorization. */
export function installModelGateway(app: Hono, gateway: ModelGateway) {
  app.use(`${PREFIX}/*`, bodyLimit({ maxSize: 12 * 1024 * 1024, onError: c => c.json({ error: '模型请求过大' }, 413) }));
  app.all(`${PREFIX}/:sessionId/v1/*`, c => gateway.forward(c.req.raw, c.req.param('sessionId'), c.req.path.slice(`${PREFIX}/${c.req.param('sessionId')}/v1/`.length)));
  app.all(`${PREFIX}/*`, c => c.json({ error: '模型运行接口不存在' }, 404));
}
