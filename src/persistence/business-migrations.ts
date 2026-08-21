import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Pool, type PoolClient } from "pg";

export const BUSINESS_DATABASE_SCHEMA = "agent_staff";
const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = "agent_staff_business_migrations";

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
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${BUSINESS_DATABASE_SCHEMA}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${BUSINESS_DATABASE_SCHEMA}.schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
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
