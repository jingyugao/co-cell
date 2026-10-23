import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { MySqlSecretRepository } from './repository.js';
import { MySqlToolRepository } from '../tools/repository.js';

class RuntimePool {
  projects = new Set(['project-fixture']);
  runtimes = new Map<string, { project_id: string; generation: number }>();
  configs = new Map<string, string>();
  statements: string[] = [];

  async query(sql: string, values: unknown[] = []): Promise<[any[], any]> {
    this.statements.push(sql);
    if (sql.startsWith('SELECT project_id,generation FROM project_tool_runtimes')) {
      const row = this.runtimes.get(String(values[0]));
      return [row ? [{ ...row }] : [], []];
    }
    if (sql.startsWith('SELECT slot,digest FROM sandbox_runtime_configs')) {
      const prefix = `${values[0]}:${values[1]}:`;
      return [[...this.configs].filter(([key]) => key.startsWith(prefix)).map(([key, digest]) => ({ slot: key.slice(prefix.length), digest })), []];
    }
    return [[], []];
  }

  async getConnection() {
    const pool = this;
    return {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async query(sql: string, values: unknown[] = []): Promise<[any[], any]> {
        pool.statements.push(sql);
        if (sql.startsWith('SELECT id FROM projects WHERE id=?')) {
          const id = String(values[0]); return [pool.projects.has(id) ? [{ id }] : [], []];
        }
        if (sql.startsWith('SELECT box_id FROM project_tool_runtimes')) {
          const box = String(values[0]); return [pool.runtimes.has(box) ? [{ box_id: box }] : [], []];
        }
        if (sql.startsWith('SELECT project_id FROM project_tool_runtimes')) {
          const row = pool.runtimes.get(String(values[0])); return [row ? [{ project_id: row.project_id }] : [], []];
        }
        if (sql.startsWith('INSERT INTO project_tool_runtimes')) {
          pool.runtimes.set(String(values[0]), { project_id: String(values[1]), generation: Number(values[2]) }); return [[], []];
        }
        if (sql.startsWith('INSERT INTO sandbox_runtime_configs')) {
          for (let i = 0; i < values.length; i += 5) pool.configs.set(`${values[i]}:${values[i + 1]}:${values[i + 2]}`, String(values[i + 3]));
          return [[], []];
        }
        if (sql.startsWith('DELETE FROM sandbox_runtime_configs')) {
          const prefix = `${values[0]}:`; for (const key of pool.configs.keys()) if (key.startsWith(prefix)) pool.configs.delete(key);
          return [[], []];
        }
        if (sql.startsWith('DELETE FROM project_tool_runtimes')) { pool.runtimes.delete(String(values[0])); return [[], []]; }
        return [[], []];
      },
    };
  }
}

test('runtime repository schema stores role and runtime metadata without credential registries', async () => {
  const pool = new RuntimePool();
  const repository = new MySqlSecretRepository(pool as unknown as Pool);
  await repository.init();
  const schema = pool.statements.filter(sql => sql.startsWith('CREATE TABLE'));
  assert(schema.some(sql => sql.includes('project_tool_runtimes')));
  assert(schema.some(sql => sql.includes('sandbox_runtime_configs')));
  assert(schema.some(sql => sql.includes('tool_roles')));
  assert(!schema.some(sql => /\bsecrets\b|secret_versions|secret_tool_configs/.test(sql)));
});

test('runtime ownership and applied config digests follow register, mark, and forget lifecycle', async () => {
  const pool = new RuntimePool();
  const repository = new MySqlSecretRepository(pool as unknown as Pool);
  await repository.registerRuntime('box-fixture', 'project-fixture', 7);
  assert.deepEqual(await repository.runtime('box-fixture'), { projectId: 'project-fixture', generation: 7 });
  await repository.markRuntimeConfigs('box-fixture', 7, { sandbox: 'digest-a', tools: 'digest-b' });
  assert.deepEqual(await repository.runtimeConfig('box-fixture', 7), { sandbox: 'digest-a', tools: 'digest-b' });
  await repository.markRuntimeConfig('box-fixture', 7, 'tools', 'digest-c');
  assert.deepEqual(await repository.runtimeConfig('box-fixture', 7), { sandbox: 'digest-a', tools: 'digest-c' });
  await repository.forgetRuntime('box-fixture');
  assert.equal(await repository.runtime('box-fixture'), null);
  assert.deepEqual(await repository.runtimeConfig('box-fixture', 7), {});
});

test('dynamic definitions persist generic hook metadata without seeding tool-specific defaults', async () => {
  let row: Record<string, unknown> | undefined;
  const statements: string[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql);
      assert.equal((sql.match(/\?/g) ?? []).length, values.length, 'SQL values must match placeholders');
      if (sql.includes('information_schema.COLUMNS')) return [[{ COLUMN_NAME: 'present' }], []];
      if (sql.startsWith('INSERT INTO tool_definitions')) {
        const columns = sql.match(/tool_definitions\s*\(([^)]+)\)/)![1].split(',').map(column => column.trim());
        let index = 0;
        row = Object.fromEntries(columns.map(column => [column, column === 'version' ? 1 : values[index++]]));
        assert.equal(index, values.length);
      } else if (sql.startsWith('UPDATE tool_definitions SET')) {
        const columns = [...sql.slice(0, sql.indexOf('WHERE name=')).matchAll(/([a-z_]+)=(?:CAST\(\? AS JSON\)|\?)/g)].map(match => match[1]);
        assert.equal(columns.length + 2, values.length);
        columns.forEach((column, index) => { row![column] = values[index]; });
        row!.version = Number(row!.version) + 1;
        return [{ affectedRows: 1 }, []];
      } else if (sql.startsWith('SELECT * FROM tool_definitions')) return [row ? [{ ...row }] : [], []];
      return [{ affectedRows: 1 }, []];
    },
  };
  const repository = new MySqlToolRepository(pool as unknown as Pool);
  await repository.init();
  assert.equal(statements.some(sql => /^INSERT|^UPDATE/.test(sql)), false, 'startup only prepares the schema');
  const definition = {
    name: 'custom', description: '', instructions: '', enabled: true, executable: '/usr/bin/custom', args: [], env: {}, timeoutMs: 20_000,
    credentialPath: '.custom/config', credentialPaths: ['.custom'], credentialExcludedPaths: ['.custom/cache'],
    credentialContext: { identity: { hostname: 'source', username: 'operator' }, targetIdentity: { hostname: 'runtime', username: 'debug' } },
  };
  const created = await repository.save(definition);
  assert.deepEqual(created.credentialContext, definition.credentialContext);
  assert.deepEqual(created.credentialExcludedPaths, definition.credentialExcludedPaths);
  const changed = { ...definition, credentialExcludedPaths: ['.custom/temp'] };
  const updated = await repository.save(changed, created.version);
  assert.equal(updated.version, created.version + 1);
  assert.deepEqual(updated.credentialExcludedPaths, ['.custom/temp']);
  assert.deepEqual((await repository.list())[0], updated);
});
