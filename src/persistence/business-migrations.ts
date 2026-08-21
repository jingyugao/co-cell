import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Pool, type PoolClient } from "pg";

export const BUSINESS_DATABASE_SCHEMA = "swarm_hive";
const LEGACY_BUSINESS_DATABASE_SCHEMA = "agent_staff";
const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = "swarm_hive_business_migrations";
const LEGACY_INITIAL_MIGRATION = "001_create_agent_staff_business_tables.sql";
const INITIAL_MIGRATION = "001_create_swarm_hive_business_tables.sql";

export interface BusinessMigrationOptions {
  connectionString: string;
  migrationsDirectory?: string;
}

async function migrationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function ensureMigrationInfrastructure(client: PoolClient): Promise<void> {
  const schemas = await client.query<{ legacy: string | null; current: string | null }>(
    "SELECT to_regnamespace($1)::text AS legacy, to_regnamespace($2)::text AS current",
    [LEGACY_BUSINESS_DATABASE_SCHEMA, BUSINESS_DATABASE_SCHEMA],
  );
  const { legacy, current } = schemas.rows[0] ?? { legacy: null, current: null };
  if (legacy && current) {
    throw new Error(
      `Both ${LEGACY_BUSINESS_DATABASE_SCHEMA} and ${BUSINESS_DATABASE_SCHEMA} schemas exist; migrate them manually before startup`,
    );
  }
  if (legacy && !current) {
    await client.query(
      `ALTER SCHEMA ${LEGACY_BUSINESS_DATABASE_SCHEMA} RENAME TO ${BUSINESS_DATABASE_SCHEMA}`,
    );
  }
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${BUSINESS_DATABASE_SCHEMA}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${BUSINESS_DATABASE_SCHEMA}.schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(
    `UPDATE ${BUSINESS_DATABASE_SCHEMA}.schema_migrations
        SET version = $1
      WHERE version = $2`,
    [INITIAL_MIGRATION, LEGACY_INITIAL_MIGRATION],
  );
}

/** Apply pending business-schema migrations under a PostgreSQL advisory lock. */
export async function migrateBusinessDatabase(
  options: BusinessMigrationOptions,
): Promise<string[]> {
  const connectionString = options.connectionString.trim();
  if (!connectionString) {
    throw new Error("AGENT_DATABASE_URL must not be empty");
  }
  const directory = resolve(options.migrationsDirectory ?? "migrations");
  const files = await migrationFiles(directory);
  if (files.length === 0) throw new Error(`No migrations found in ${directory}`);

  const pool = new Pool({ connectionString, max: 1 });
  const applied: string[] = [];
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [
        MIGRATION_LOCK_KEY,
      ]);
      await ensureMigrationInfrastructure(client);
      const existing = await client.query<{ version: string }>(
        `SELECT version FROM ${BUSINESS_DATABASE_SCHEMA}.schema_migrations`,
      );
      const appliedVersions = new Set(existing.rows.map((row) => row.version));

      for (const file of files) {
        if (appliedVersions.has(file)) continue;
        const sql = await readFile(resolve(directory, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            `INSERT INTO ${BUSINESS_DATABASE_SCHEMA}.schema_migrations(version) VALUES ($1)`,
            [file],
          );
          await client.query("COMMIT");
          applied.push(file);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      return applied;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY])
        .catch(() => undefined);
      client.release();
    }
  } finally {
    await pool.end();
  }
}
