import { randomUUID } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ApiResource, ApiResourceInput, ApiResourceSettings, ManagedApiResource } from '../../protocol/api-resource-types.js';
import { HttpError } from '../../util/errors.js';
import type { SecretCrypto } from '../secrets/crypto.js';
import { projectApiResourceNamesSql } from '../secrets/role-repository.js';

const columns = 'name, description, endpoint, auth_header, auth_scheme, extra_headers, revision';
const reservedHeader = /^(?:host$|connection$|keep-alive$|transfer-encoding$|content-length$|te$|trailer$|upgrade$|expect$|forwarded$|proxy-|sec-|x-forwarded-|x-cocell-)/i;
interface StoredHeader { name: string; sealed: string }

function storedHeaders(row?: RowDataPacket): StoredHeader[] {
  const value = row?.extra_headers;
  return typeof value === 'string' ? JSON.parse(value) : value ?? [];
}

function checkHeader(name: string, value?: string) {
  try {
    validateHeaderName(name);
    if (value !== undefined) validateHeaderValue(name, value);
  } catch { throw new HttpError(400, '请求头名称或值包含无效字符'); }
  if (reservedHeader.test(name)) throw new HttpError(400, '该请求头由代理管理');
}

function resource(row: RowDataPacket): ManagedApiResource {
  return { name: row.name, description: row.description, endpoint: row.endpoint, authHeader: row.auth_header,
    authScheme: row.auth_scheme, headerNames: storedHeaders(row).map(header => header.name), revision: row.revision };
}

export class ApiResourceStore {
  constructor(private pool: Pool, private crypto: SecretCrypto) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS api_proxy_resources (
      name VARCHAR(64) PRIMARY KEY, description VARCHAR(500) NOT NULL, endpoint VARCHAR(2048) NOT NULL,
      auth_header VARCHAR(128) NOT NULL, auth_scheme VARCHAR(64) NOT NULL, sealed_key TEXT NOT NULL,
      extra_headers JSON NULL, revision CHAR(36) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [existing] = await this.pool.query<RowDataPacket[]>(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='api_proxy_resources' AND COLUMN_NAME='extra_headers'`);
    if (!existing.length) {
      try { await this.pool.query('ALTER TABLE api_proxy_resources ADD COLUMN extra_headers JSON NULL'); }
      catch (error) { if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error; }
    }
    // Older replicas require this column during rolling upgrades. New resources leave it empty.
    const [legacy] = await this.pool.query<RowDataPacket[]>(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='api_proxy_resources' AND COLUMN_NAME='project_ids' AND COLUMN_DEFAULT IS NULL AND IS_NULLABLE='NO'`);
    if (legacy.length) await this.pool.query('ALTER TABLE api_proxy_resources ALTER COLUMN project_ids SET DEFAULT (JSON_ARRAY())');
  }

  async list(): Promise<ManagedApiResource[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT ${columns} FROM api_proxy_resources ORDER BY name`);
    return rows.map(resource);
  }

  async projectForBox(boxId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT id FROM projects WHERE current_box_id=? AND removed_at IS NULL AND status <> 'archived' LIMIT 2", [boxId]);
    if (rows.length !== 1) throw new HttpError(403, 'Box 未绑定当前项目');
    return String(rows[0].id);
  }

  async available(projectId: string): Promise<ApiResource[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT name, description FROM api_proxy_resources WHERE name IN (${projectApiResourceNamesSql}) ORDER BY name`, [projectId]);
    return rows.map(row => ({ name: row.name, description: row.description }));
  }

  async upstream(projectId: string, name: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT endpoint, auth_header, auth_scheme, sealed_key, extra_headers FROM api_proxy_resources
       WHERE name=? AND name IN (${projectApiResourceNamesSql})`, [name, projectId]);
    if (!rows.length) throw new HttpError(403, '项目角色未获准使用此资源');
    const row = rows[0];
    const id = 'api-proxy:' + name;
    const headers: Record<string, string> = Object.create(null);
    for (const header of storedHeaders(row)) {
      const field = header.name.toLowerCase();
      headers[field] = this.crypto.open(id, 'header:' + field, header.sealed).toString('utf8');
    }
    const auth = String(row.auth_header).toLowerCase();
    if (auth) {
      const key = this.crypto.open(id, '1', row.sealed_key).toString('utf8');
      headers[auth] = row.auth_scheme ? row.auth_scheme + ' ' + key : key;
    }
    return { endpoint: String(row.endpoint), authHeader: auth, headers };
  }

  async save(input: ApiResourceInput & ApiResourceSettings, expected?: string): Promise<ManagedApiResource> {
    const { apiKey, headers, ...settings } = input;
    let endpoint: URL;
    try { endpoint = new URL(settings.endpoint); } catch { throw new HttpError(400, '上游地址无效'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || /[?#]/.test(endpoint.href))
      throw new HttpError(400, '上游地址仅支持 HTTP(S) 地址和路径');
    settings.endpoint = endpoint.href;

    let previous: RowDataPacket | undefined;
    if (expected !== undefined) {
      const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT endpoint, auth_header, sealed_key, extra_headers
        FROM api_proxy_resources WHERE name=? AND revision=?`, [settings.name, expected]);
      previous = rows[0];
      if (!previous) throw new HttpError(409, '资源已变更，请刷新后重试');
    }
    const sameEndpoint = previous?.endpoint === settings.endpoint;
    const id = 'api-proxy:' + settings.name;
    let sealedKey = '';
    if (settings.authHeader) {
      checkHeader(settings.authHeader, apiKey);
      if (/^(?:content-|cookie$)/i.test(settings.authHeader)) throw new HttpError(400, '请使用专用 API Key 认证头');
      if (apiKey !== undefined) sealedKey = this.crypto.seal(id, '1', Buffer.from(apiKey));
      else if (previous && sameEndpoint && previous.auth_header.toLowerCase() === settings.authHeader.toLowerCase()) sealedKey = previous.sealed_key;
      if (!sealedKey) throw new HttpError(400, '请为当前上游和认证头填写 API Key');
    } else if (apiKey !== undefined || settings.authScheme) throw new HttpError(400, '请填写 API Key 对应的认证请求头');

    const oldHeaders = storedHeaders(previous);
    const oldValues = new Map(oldHeaders.map(header => [header.name.toLowerCase(), header.sealed]));
    const seen = new Set([settings.authHeader.toLowerCase()]);
    const requested = headers ?? oldHeaders.map(({ name }) => ({ name, value: undefined }));
    const extraHeaders: StoredHeader[] = requested.map(({ name, value }) => {
      checkHeader(name, value);
      const field = name.toLowerCase();
      if (seen.has(field)) throw new HttpError(400, '请求头 ' + name + ' 重复');
      seen.add(field);
      const sealed = value === undefined ? sameEndpoint && oldValues.get(field)
        : this.crypto.seal(id, 'header:' + field, Buffer.from(value));
      if (!sealed) throw new HttpError(400, '请为当前上游填写请求头 ' + name + ' 的值');
      return { name, sealed };
    });

    const revision = randomUUID();
    const values = [settings.description, settings.endpoint, settings.authHeader, settings.authScheme, sealedKey,
      JSON.stringify(extraHeaders), revision, settings.name];
    if (expected === undefined) {
      try {
        await this.pool.query(`INSERT INTO api_proxy_resources
          (description,endpoint,auth_header,auth_scheme,sealed_key,extra_headers,revision,name) VALUES (?,?,?,?,?,?,?,?)`, values);
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, '资源名已存在');
        throw error;
      }
    } else {
      const [result] = await this.pool.query<ResultSetHeader>(`UPDATE api_proxy_resources SET description=?, endpoint=?,
        auth_header=?, auth_scheme=?, sealed_key=?, extra_headers=?, revision=? WHERE name=? AND revision=?`, [...values, expected]);
      if (!result.affectedRows) throw new HttpError(409, '资源已变更，请刷新后重试');
    }
    return { ...settings, headerNames: extraHeaders.map(header => header.name), revision };
  }

  async remove(name: string, revision: string) {
    const [result] = await this.pool.query<ResultSetHeader>('DELETE FROM api_proxy_resources WHERE name=? AND revision=?', [name, revision]);
    if (!result.affectedRows) throw new HttpError(409, '资源已变更，请刷新后重试');
  }
}
