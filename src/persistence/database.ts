import { Pool } from "pg";

export interface BusinessDatabase {
  pool: Pool;
  close(): Promise<void>;
}

export function createBusinessDatabase(connectionString: string): BusinessDatabase {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return {
    pool,
    close: () => pool.end(),
  };
}
