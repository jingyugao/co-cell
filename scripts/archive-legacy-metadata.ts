import { loadEnvFile } from 'node:process';
import { createPool } from 'mysql2/promise';
import { archiveLegacyMetadata } from '../backend/infra/storage/archive-legacy.js';

try { loadEnvFile(); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log('Usage: pnpm exec tsx scripts/archive-legacy-metadata.ts\n\nArchives the old projects/sessions document tables in the configured MySQL database. No rows are copied or deleted.');
  process.exit(0);
}
if (args.length) throw new Error('Usage: pnpm exec tsx scripts/archive-legacy-metadata.ts [--help]');

const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error('MYSQL_URL is required.');

let pool;
try {
  pool = createPool({ uri: mysqlUrl, connectionLimit: 1, charset: 'utf8mb4', timezone: 'Z' });
} catch {
  throw new Error('MYSQL_URL must be a valid MySQL connection URL.');
}

try {
  const result = await archiveLegacyMetadata(pool);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Legacy metadata archive failed: ${message.replace(/mysql:\/\/[^\s]+/gi, 'mysql://[redacted]')}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
