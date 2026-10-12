import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { MemoryPreviewGrantStore, MySqlPreviewGrantStore, type PreviewGrant } from './preview-grants.js';

const grant = (overrides: Partial<PreviewGrant> = {}): PreviewGrant => ({
  host: 'project-1-8000.preview.example.test',
  path: '/admin.php/index/index?from=grant',
  challenge: 'browser-challenge-1',
  expires: Date.now() + 60_000,
  ...overrides,
});

test('memory preview grants are one-use and reject mismatched host or challenge without consuming', async () => {
  const store = new MemoryPreviewGrantStore();
  const expected = grant();
  const code = await store.issue(expected);

  assert.equal(await store.consume(code, 'other.preview.example.test', expected.challenge), undefined);
  assert.equal(await store.consume(code, expected.host, 'other-challenge'), undefined);
  assert.deepEqual(await store.consume(code, expected.host, expected.challenge), expected);
  assert.equal(await store.consume(code, expected.host, expected.challenge), undefined);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
});

test('memory preview grants expire and simultaneous redemption has one winner', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const store = new MemoryPreviewGrantStore();
  const code = await store.issue(grant({ expires: now + 10 }));
  now += 10;
  assert.equal(await store.consume(code, grant().host, grant().challenge), undefined);

  const concurrentCode = await store.issue(grant({ expires: now + 100 }));
  const attempts = await Promise.all(Array.from({ length: 8 }, () =>
    store.consume(concurrentCode, grant().host, grant().challenge)));
  assert.equal(attempts.filter(Boolean).length, 1);
});

test('MySQL store hashes codes and lets only the conditional delete winner redeem', async () => {
  const rows = new Map<string, { host: string; path: string; challenge: string; expires: number }>();
  const statements: string[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql);
      if (sql.startsWith('CREATE TABLE')) return [{ affectedRows: 0 }, []];
      if (sql.startsWith('DELETE FROM preview_grants WHERE expires')) return [{ affectedRows: 0 }, []];
      if (sql.startsWith('INSERT INTO preview_grants')) {
        const [hash, host, path, challenge, expires] = values as [string, string, string, string, number];
        rows.set(hash, { host, path, challenge, expires });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('SELECT host')) {
        const [hash, host, challenge, now] = values as [string, string, string, number];
        const row = rows.get(hash);
        return [[...(row && row.host === host && row.challenge === challenge && row.expires > now
          ? [{ ...row }] : [])], []];
      }
      if (sql.startsWith('DELETE FROM preview_grants WHERE code_hash')) {
        const [hash, host, challenge, now] = values as [string, string, string, number];
        const row = rows.get(hash);
        if (!row || row.host !== host || row.challenge !== challenge || row.expires <= now) {
          return [{ affectedRows: 0 }, []];
        }
        rows.delete(hash);
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pick<Pool, 'query'>;

  const store = new MySqlPreviewGrantStore(pool);
  await store.init();
  const expected = grant();
  const code = await store.issue(expected);
  const hash = [...rows.keys()][0];
  assert.ok(hash);
  assert.notEqual(hash, code);
  assert.equal(hash.length, 64);
  assert.equal(await store.consume(code, 'wrong.preview.example.test', expected.challenge), undefined);
  assert.equal(await store.consume(code, expected.host, 'wrong-challenge'), undefined);

  const attempts = await Promise.all(Array.from({ length: 8 }, () =>
    store.consume(code, expected.host, expected.challenge)));
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.deepEqual(attempts.find(Boolean), expected);
  assert.equal(rows.size, 0);
  assert.match(statements[0], /INDEX preview_grants_expires \(expires\)/);
  assert.match(statements.at(-1)!, /DELETE FROM preview_grants WHERE code_hash = \? AND host = \? AND challenge = \? AND expires > \?/);
});
