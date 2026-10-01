import { createHash } from 'node:crypto';
import type { RegistryAuth, RegistryTagsPage } from '../../protocol/image-types.js';
import { HttpError } from '../../util/errors.js';

const tagPattern = /^[\w][\w.-]{0,127}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const manifestAccept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

/** Store a repository, never a tag, digest, URL credential or query string. */
export function normalizeRepository(input: string): string {
  let value = input.trim();
  const invalid = () => new HttpError(400, '请输入不含 Tag 或 digest 的镜像仓库，例如 docker.io/library/node');
  if (/^(?:https?:\/\/)?hub\.docker\.com\//i.test(value)) {
    let page: URL;
    try { page = new URL(value.includes('://') ? value : `https://${value}`); } catch { throw invalid(); }
    if (value.length > 2048 || page.username || page.password || page.host !== 'hub.docker.com') throw invalid();
    const repository = /^\/r\/([^/]+)\/([^/]+)(?:\/tags)?\/?$/.exec(page.pathname);
    const official = /^\/_\/([^/]+)(?:\/tags)?\/?$/.exec(page.pathname);
    if (repository) value = `docker.io/${repository[1]}/${repository[2]}`;
    else if (official) value = `docker.io/library/${official[1]}`;
    else throw new HttpError(400, '请使用 Docker Hub 仓库主页链接，或填写 docker.io/用户名/镜像名');
  }
  if (!value || value.length > 2048 || /[\s@?#\\\0]/.test(value)) throw invalid();
  const explicit = /^https?:\/\//.test(value);
  if (value.includes('://') && !explicit) throw invalid();
  let protocol = '';
  if (explicit) {
    protocol = value.startsWith('http://') ? 'http://' : 'https://';
    value = value.slice(protocol.length);
  }
  value = value.replace(/\/$/, '');
  const parts = value.split('/');
  const hasHost = explicit || parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost');
  let host = hasHost ? parts.shift()! : 'docker.io';
  if (/[^a-zA-Z0-9.:-]/.test(host) || !host) throw invalid();
  try {
    const url = new URL(`${protocol || 'https://'}${host}`);
    if (!url.hostname || url.username || url.password || url.pathname !== '/') throw invalid();
    host = url.host;
  } catch { throw invalid(); }
  if (['index.docker.io', 'registry-1.docker.io'].includes(host)) host = 'docker.io';
  if (host === 'docker.io' && parts.length === 1) parts.unshift('library');
  if (!parts.length || parts.join('/').length > 255 || parts.some(part => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(part))) throw invalid();
  // Docker Hub always uses TLS; other repositories may explicitly select HTTP.
  return `${host === 'docker.io' || protocol === 'https://' ? '' : protocol}${host}/${parts.join('/')}`;
}

export function registryImageReference(repository: string, tagOrDigest: string): string {
  const repo = normalizeRepository(repository).replace(/^https?:\/\//, '');
  if (!tagPattern.test(tagOrDigest) && !digestPattern.test(tagOrDigest)) throw new HttpError(400, '无效的镜像 Tag 或 digest');
  return `${repo}${digestPattern.test(tagOrDigest) ? '@' : ':'}${tagOrDigest}`;
}

function address(repository: string) {
  const normalized = normalizeRepository(repository);
  const value = normalized.replace(/^http:\/\//, '');
  const slash = value.indexOf('/');
  const host = value.slice(0, slash);
  return { origin: host === 'docker.io' ? 'https://registry-1.docker.io' : `${normalized.startsWith('http://') ? 'http' : 'https'}://${host}`,
    path: value.slice(slash + 1) };
}

export interface ImageRegistry {
  listTags(repository: string, auth?: RegistryAuth, options?: { last?: string; limit?: number }): Promise<RegistryTagsPage>;
  resolveTag(repository: string, tag: string, auth?: RegistryAuth): Promise<string>;
}

/** Only metadata is fetched. Tokens and user credentials live for one request. */
export class DockerRegistryClient implements ImageRegistry {
  constructor(private fetcher: typeof fetch = fetch) {}

  private async read(response: Response, limit = 2 * 1024 * 1024): Promise<Buffer> {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new HttpError(502, '仓库返回的元数据过大');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  }

  private async request(repository: string, path: string, auth?: RegistryAuth, method = 'GET'): Promise<Response> {
    const remote = address(repository);
    const url = new URL(path, remote.origin);
    const signal = AbortSignal.timeout(20_000);
    const headers = new Headers({ Accept: url.pathname.endsWith('/tags/list') ? 'application/json' : manifestAccept });
    const send = () => this.fetcher(url, { method, headers, redirect: 'manual', signal });
    try {
      let response = await send();
      if (response.status === 401) {
        const challenge = response.headers.get('www-authenticate') ?? '';
        await response.body?.cancel();
        if (/^Basic\s/i.test(challenge) && auth) {
          headers.set('Authorization', `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`);
        } else if (/^Bearer\s/i.test(challenge)) {
          const parameters = Object.fromEntries([...challenge.matchAll(/([a-z]+)="([^"\r\n]*)"/gi)].map(match => [match[1].toLowerCase(), match[2]]));
          let realm: URL;
          try { realm = new URL(parameters.realm); } catch { throw new HttpError(502, '仓库返回了无效的认证地址'); }
          if (realm.username || realm.password || realm.hash || !['http:', 'https:'].includes(realm.protocol)
            || url.protocol === 'https:' && realm.protocol !== 'https:') throw new HttpError(502, '仓库返回了不安全的认证地址');
          // Registries can delegate authentication to a separate token service.
          // Follow that challenge over TLS; HTTP credentials stay same-origin.
          if (auth && realm.origin !== url.origin && realm.protocol !== 'https:') throw new HttpError(502, '仓库返回了不安全的认证地址');
          if (parameters.service) realm.searchParams.set('service', parameters.service);
          realm.searchParams.set('scope', `repository:${remote.path}:pull`);
          const tokenHeaders = new Headers();
          if (auth) tokenHeaders.set('Authorization', `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`);
          const tokenResponse = await this.fetcher(realm, { headers: tokenHeaders, redirect: 'manual', signal });
          if (!tokenResponse.ok) { await tokenResponse.body?.cancel(); throw new HttpError(tokenResponse.status === 429 ? 429 : 400, '无法获取仓库访问凭证，请检查仓库权限或稍后重试'); }
          const body = JSON.parse((await this.read(tokenResponse)).toString()) as { token?: unknown; access_token?: unknown };
          const token = body.token ?? body.access_token;
          if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/.test(token)) throw new HttpError(502, '仓库认证服务未返回有效凭证');
          headers.set('Authorization', `Bearer ${token}`);
        } else throw new HttpError(400, '仓库需要认证，请提供用户名和 Token');
        response = await send();
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new HttpError(400, '仓库认证失败，请检查用户名、Token 和读取权限');
        if (response.status === 404) throw new HttpError(404, '镜像仓库或 Tag 不存在');
        if (response.status === 429) throw new HttpError(429, '镜像仓库请求频率受限，请稍后重试');
        if (method === 'HEAD' && [405, 501].includes(response.status)) return response;
        throw new HttpError(502, '无法查询镜像仓库，请检查仓库地址');
      }
      return response;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '镜像仓库连接失败或响应超时，请稍后重试');
    }
  }

  async listTags(repository: string, auth?: RegistryAuth, options: { last?: string; limit?: number } = {}): Promise<RegistryTagsPage> {
    const remote = address(repository);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || options.last && !tagPattern.test(options.last)) throw new HttpError(400, '无效的版本分页参数');
    const url = new URL(`/v2/${remote.path}/tags/list`, remote.origin);
    url.searchParams.set('n', String(limit));
    if (options.last) url.searchParams.set('last', options.last);
    const response = await this.request(repository, url.pathname + url.search, auth);
    let body: { tags?: unknown };
    try { body = JSON.parse((await this.read(response)).toString()); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, '仓库返回了无效的版本列表'); }
    if (!body || typeof body !== 'object' || body.tags !== null && (!Array.isArray(body.tags) || body.tags.length > 10000 || body.tags.some(tag => typeof tag !== 'string' || !tagPattern.test(tag)))) throw new HttpError(502, '仓库返回了无效的版本列表');
    const tags = (body.tags ?? []) as string[];
    let next: string | undefined;
    const link = response.headers.get('link');
    if (link) {
      const match = link.match(/<([^>]+)>;\s*rel="?next"?/i);
      if (match) {
        let target: URL;
        try { target = new URL(match[1], url); } catch { throw new HttpError(502, '仓库返回了无效的分页地址'); }
        if (target.origin !== url.origin || target.pathname !== url.pathname) throw new HttpError(502, '仓库返回了无效的分页地址');
        const last = target.searchParams.get('last');
        if (!last || !tagPattern.test(last) || last === options.last) throw new HttpError(502, '仓库返回了无效的版本游标');
        next = last;
      }
    } else if (tags.length === limit && tags.at(-1) !== options.last) next = tags.at(-1);
    return { tags: [...new Set(tags)], ...(next ? { next } : {}) };
  }

  async resolveTag(repository: string, tag: string, auth?: RegistryAuth): Promise<string> {
    if (!tagPattern.test(tag)) throw new HttpError(400, '无效的上游 Tag');
    const remote = address(repository);
    const path = `/v2/${remote.path}/manifests/${tag}`;
    const head = await this.request(repository, path, auth, 'HEAD');
    const digest = head.headers.get('docker-content-digest');
    if (head.ok && digest && digestPattern.test(digest)) return digest;
    const response = await this.request(repository, path, auth);
    let content: Buffer;
    try { content = await this.read(response, 8 * 1024 * 1024); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, '无法读取镜像元数据'); }
    try {
      const body = JSON.parse(content.toString());
      if (body.schemaVersion !== 2 || !body.config && !body.manifests) throw new Error();
    } catch { throw new HttpError(502, '仓库返回了无效的镜像元数据'); }
    const computed = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (response.headers.has('docker-content-digest') && response.headers.get('docker-content-digest') !== computed) throw new HttpError(502, '镜像元数据与 digest 不一致');
    return computed;
  }
}
