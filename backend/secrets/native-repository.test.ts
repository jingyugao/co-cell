import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { SecretCrypto } from './crypto.js';
import { NativeSecretFiles } from './native-files.js';
import { MySqlSecretRepository, type StoredSecret, type StoredVersion } from './repository.js';

const secretId = '123e4567-e89b-42d3-a456-426614174000';
const currentId = '223e4567-e89b-42d3-a456-426614174000';
const editedId = '323e4567-e89b-42d3-a456-426614174000';
const time = '2026-01-01T00:00:00.000Z';
type SecretRow = { id: string; name: string; format: string; mutable: boolean; enabled: boolean; version: number;
  current_version_id: string; ciphertext: string; created_at: string; updated_at: string; tool?: string; path?: string; alias?: string };
type VersionRow = { id: string; secret_id: string; source: string; base_version: number | null; created_at: string;
  project_id: string | null; invocation_id: string | null; changes_json: string; ciphertext: string };
type State = { secrets: Map<string, SecretRow>; versions: Map<string, VersionRow>; configs: Map<string, { tool: string; path: string; alias: string }> };

function clone(state: State): State {
  return { secrets: new Map([...state.secrets].map(([id, row]) => [id, { ...row }])),
    versions: new Map([...state.versions].map(([id, row]) => [id, { ...row }])),
    configs: new Map([...state.configs].map(([id, row]) => [id, { ...row }])) };
}

/** Minimal transaction fake for the secret repository's SQL boundary. */
class FakePool {
  state: State = { secrets: new Map(), versions: new Map(), configs: new Map() };
  statements: Array<{ sql: string; values: unknown[] }> = [];
  failSqlIncludes?: string;
  commitFailure?: 'rolled-back' | 'lost-ack';

  private row(id: string) {
    const row = this.state.secrets.get(id); return row ? { ...row, ...(this.state.configs.get(id) ?? {}) } : undefined;
  }
  async query(sql: string, values: unknown[] = []): Promise<[any[], any]> {
    this.statements.push({ sql, values: [...values] });
    if (sql === 'SELECT current_version_id FROM secrets WHERE id=? FOR UPDATE' || sql === 'SELECT ciphertext FROM secrets WHERE id=? FOR UPDATE') {
      const row = this.state.secrets.get(String(values[0])); return [row ? [row] : [], []];
    }
    if (sql.includes('FROM secrets s LEFT JOIN secret_tool_configs') && sql.includes('WHERE s.id=?')) {
      const row = this.row(String(values[0])); return [row ? [row] : [], []];
    }
    if (sql.includes('FROM secrets s LEFT JOIN secret_tool_configs'))
      return [[...this.state.secrets.keys()].map(id => this.row(id)!), []];
    if (sql === 'SELECT id FROM secrets ORDER BY id') return [[...this.state.secrets.keys()].sort().map(id => ({ id })), []];
    if (sql.includes('FROM secret_versions WHERE secret_id=? ORDER BY created_at')) {
      return [[...this.state.versions.values()].filter(row => row.secret_id === values[0])
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100), []];
    }
    throw new Error(`Unexpected pool SQL: ${sql}`);
  }
  async getConnection() {
    const pool = this; let before: State | undefined; let active = false;
    return {
      async beginTransaction() { before = clone(pool.state); active = true; },
      async query(sql: string, values: unknown[] = []): Promise<[any[], any]> { return pool.connectionQuery(sql, values); },
      async commit() {
        const failure = pool.commitFailure; pool.commitFailure = undefined;
        if (failure === 'rolled-back' && before) pool.state = before;
        active = false; before = undefined;
        if (failure) throw new Error('injected commit failure');
      },
      async rollback() { if (active && before) pool.state = before; active = false; before = undefined; },
      release() {},
    };
  }
  private async connectionQuery(sql: string, values: unknown[]): Promise<[any[], any]> {
    this.statements.push({ sql, values: [...values] });
    if (this.failSqlIncludes && sql.includes(this.failSqlIncludes)) {
      this.failSqlIncludes = undefined; throw new Error('injected SQL failure');
    }
    if (sql.startsWith('SELECT id FROM secrets WHERE id=? FOR UPDATE')) return [this.state.secrets.has(String(values[0])) ? [{ id: values[0] }] : [], []];
    if (sql.startsWith('SELECT s.*,c.tool,c.path,c.alias FROM secrets s LEFT JOIN secret_tool_configs')) {
      const row = this.row(String(values[0])); return [row ? [row] : [], []];
    }
    if (sql.startsWith("SELECT id FROM secret_versions WHERE secret_id=? AND ciphertext<>''")) {
      return [[...this.state.versions.values()].filter(row => row.secret_id === values[0] && row.ciphertext !== '').map(row => ({ id: row.id })), []];
    }
    if (sql.startsWith('INSERT INTO secrets(')) {
      const [id, name, format, mutable, enabled, versionId, ciphertext, createdAt, updatedAt] = values as [string, string, string, boolean, boolean, string, string, string, string];
      this.state.secrets.set(id, { id, name, format, mutable, enabled, version: 1, current_version_id: versionId, ciphertext, created_at: createdAt, updated_at: updatedAt });
      return [[], []];
    }
    if (sql.startsWith('UPDATE secrets SET name=?')) {
      const [name, mutable, enabled, updatedAt, ...tail] = values; const id = String(tail.at(-1));
      const row = this.state.secrets.get(id); if (!row) return [[], []];
      Object.assign(row, { name, mutable, enabled, updated_at: updatedAt });
      if (sql.includes(',format=?,version=version+1,current_version_id=?,ciphertext=?')) {
        const [format, versionId, ciphertext] = tail;
        Object.assign(row, { format, version: row.version + 1, current_version_id: versionId, ciphertext });
      }
      return [[], []];
    }
    if (sql.startsWith('UPDATE secrets SET ciphertext=?')) {
      const [ciphertext, id] = values; const row = this.state.secrets.get(String(id)); if (row) row.ciphertext = String(ciphertext); return [[], []];
    }
    if (sql.startsWith('INSERT INTO secret_tool_configs')) {
      const [id, tool, path, alias] = values as [string, string, string, string]; this.state.configs.set(id, { tool, path, alias }); return [[], []];
    }
    if (sql.startsWith('INSERT INTO secret_versions(')) {
      const [id, secretId, source, baseVersion, createdAt, projectId, invocationId, changes, ciphertext] = values as [string, string, string, number | null, string, string | null, string | null, string, string];
      this.state.versions.set(id, { id, secret_id: secretId, source, base_version: baseVersion, created_at: createdAt, project_id: projectId, invocation_id: invocationId, changes_json: changes, ciphertext }); return [[], []];
    }
    if (sql.startsWith("UPDATE secret_versions SET ciphertext='' WHERE secret_id=?")) {
      for (const row of this.state.versions.values()) if (row.secret_id === values[0]) row.ciphertext = '';
      return [[], []];
    }
    throw new Error(`Unexpected connection SQL: ${sql}`);
  }
}

const crypto = () => new SecretCrypto(Buffer.alloc(32, 7).toString('base64'));
function makeSecret(crypto: SecretCrypto, version = 0, currentVersionId = currentId, value = 'synthetic-native-token'): StoredSecret {
  return { id: secretId, name: 'Synthetic', format: 'text', mutable: true, enabled: true, version, currentVersionId,
    ciphertext: crypto.seal(secretId, currentVersionId, Buffer.from(value)), createdAt: time, updatedAt: time,
    tool: 'synthetic-tool', path: '.tool/config.json', alias: 'default' };
}
function makeVersion(crypto: SecretCrypto, id: string, value: string, changes: string[], baseVersion: number | null): StoredVersion {
  return { id, secretId, source: 'operator', baseVersion, createdAt: time, projectId: null, invocationId: null, changes,
    ciphertext: crypto.seal(secretId, id, Buffer.from(value)) };
}
function newRepository(pool: FakePool, root: string, seal: SecretCrypto) {
  return new MySqlSecretRepository(pool as unknown as Pool, new NativeSecretFiles(root, seal));
}
async function withRoot(run: (root: string, crypto: SecretCrypto) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'cocell-native-repository-'));
  const seal = crypto(); try { await run(root, seal); } finally { await rm(root, { recursive: true, force: true }); }
}
function nativePath(root: string) { return join(root, secretId, '.tool/config.json'); }

test('persists only native references and empty audit bodies; repository reads live native edits', async () => {
  await withRoot(async (root, seal) => {
    const pool = new FakePool(), first = newRepository(pool, root, seal), second = newRepository(pool, root, seal);
    const initial = makeSecret(seal); const initialVersion = makeVersion(seal, currentId, 'synthetic-native-token', ['created'], null);
    await first.save(initial, initialVersion);
    assert.match(pool.state.secrets.get(secretId)!.ciphertext, /^native:v1:/);
    assert.equal(pool.state.versions.get(currentId)!.ciphertext, '');
    assert.equal(await readFile(nativePath(root), 'utf8'), 'synthetic-native-token');
    assert(!pool.statements.some(statement => statement.values.some(value => value === 'synthetic-native-token')));

    const changed = 'refreshed-by-native-cli'; await writeFile(nativePath(root), changed);
    const loaded = await second.get(secretId);
    assert.equal(loaded?.nativeHome, secretId);
    assert.equal(seal.open(secretId, currentId, loaded!.ciphertext).toString('utf8'), changed);
    assert.equal(seal.open(secretId, currentId, (await second.list())[0].ciphertext).toString('utf8'), changed);
    assert.equal((await second.versions(secretId))[0].ciphertext, '');
  });
});

test('metadata-only rename leaves the native bytes untouched and audit history stores no body', async () => {
  await withRoot(async (root, seal) => {
    const pool = new FakePool(), repo = newRepository(pool, root, seal);
    await repo.save(makeSecret(seal), makeVersion(seal, currentId, 'native-state', ['created'], null));
    const original = await readFile(nativePath(root));
    const referenceBefore = pool.state.secrets.get(secretId)!.ciphertext;
    const versionBefore = pool.state.secrets.get(secretId)!.current_version_id;
    const current = await repo.get(secretId);
    await repo.save({ ...current!, name: 'Renamed', updatedAt: '2026-01-02T00:00:00.000Z' },
      makeVersion(seal, editedId, 'must-not-be-written', ['name'], 1));
    assert.deepEqual(await readFile(nativePath(root)), original);
    assert.equal(pool.state.secrets.get(secretId)!.ciphertext, referenceBefore);
    assert.equal(pool.state.secrets.get(secretId)!.current_version_id, versionBefore);
    assert.equal(pool.state.versions.get(editedId)!.ciphertext, '');
    assert.equal((await repo.get(secretId))?.name, 'Renamed');
  });
});

test('an SQL failure after native prepare restores the previous bytes and creates no disk backup', async () => {
  await withRoot(async (root, seal) => {
    const pool = new FakePool(), repo = newRepository(pool, root, seal);
    await repo.save(makeSecret(seal), makeVersion(seal, currentId, 'old-native-state', ['created'], null));
    const before = await readFile(nativePath(root));
    pool.failSqlIncludes = 'INSERT INTO secret_versions';
    const changed = { ...makeSecret(seal, 1, currentId, 'old-native-state'), updatedAt: '2026-01-02T00:00:00.000Z' };
    await assert.rejects(repo.save(changed, makeVersion(seal, editedId, 'new-native-state', ['content'], 1)), /injected SQL failure/);
    assert.deepEqual(await readFile(nativePath(root)), before);
    assert.equal(pool.state.secrets.get(secretId)?.version, 1);
    assert.equal(pool.state.versions.has(editedId), false);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(join(root, secretId, '.tool')), ['config.json']);
  });
});

test('explicit migration clears every historical body, is idempotent, and missing native files fail closed', async () => {
  await withRoot(async (root, seal) => {
    const pool = new FakePool(), repo = newRepository(pool, root, seal), count = 105;
    const legacy = makeSecret(seal, count, currentId, 'legacy-current-native-bytes');
    pool.state.secrets.set(secretId, { id: secretId, name: legacy.name, format: 'text', mutable: true, enabled: true, version: count,
      current_version_id: currentId, ciphertext: legacy.ciphertext, created_at: time, updated_at: time });
    pool.state.configs.set(secretId, { tool: 'synthetic-tool', path: '.tool/config.json', alias: 'default' });
    const ids = Array.from({ length: count }, (_, i) => `${String(i + 4).padStart(8, '0')}-e89b-42d3-a456-426614174000`);
    for (let i = 0; i < ids.length; i++) pool.state.versions.set(ids[i], { id: ids[i], secret_id: secretId, source: 'operator', base_version: i,
      created_at: `${time}-${String(i).padStart(3, '0')}`, project_id: null, invocation_id: null, changes_json: '["content"]', ciphertext: `legacy-history-${i}` });

    assert.deepEqual(await repo.migrateNativeFiles(), { currentMigrated: 1, historyCleared: count });
    assert.match(pool.state.secrets.get(secretId)!.ciphertext, /^native:v1:/);
    assert.equal(await readFile(nativePath(root), 'utf8'), 'legacy-current-native-bytes');
    assert([...pool.state.versions.values()].every(row => row.ciphertext === ''));
    assert.deepEqual(await repo.migrateNativeFiles(), { currentMigrated: 0, historyCleared: 0 });
    assert.equal(seal.open(secretId, currentId, (await repo.get(secretId))!.ciphertext).toString('utf8'), 'legacy-current-native-bytes');

    await rm(nativePath(root));
    await assert.rejects(repo.get(secretId), /ENOENT|missing|not found/i);
  });
});

test('commit errors reconcile the locked DB outcome before retaining or restoring native bytes', async () => {
  for (const failure of ['rolled-back', 'lost-ack'] as const) await withRoot(async (root, seal) => {
    const pool = new FakePool(), repo = newRepository(pool, root, seal);
    await repo.save(makeSecret(seal), makeVersion(seal, currentId, 'old-state', ['created'], null));
    const before = await readFile(nativePath(root), 'utf8');
    const current = await repo.get(secretId);
    pool.commitFailure = failure;
    await assert.rejects(repo.save(current!, makeVersion(seal, editedId, 'new-state', ['content'], 1)), /injected commit failure/);
    assert.equal(await readFile(nativePath(root), 'utf8'), failure === 'rolled-back' ? before : 'new-state');
    const after = (await repo.get(secretId))!;
    assert.equal(after.currentVersionId, failure === 'rolled-back' ? currentId : editedId);
  });
});
