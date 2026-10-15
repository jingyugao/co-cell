import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import { MySqlSecretRepository } from '../backend/secrets/repository.js';
import { NativeSecretFiles } from '../backend/secrets/native-files.js';
import { SecretCrypto } from '../backend/secrets/crypto.js';
import { loadSharedMountConfig } from '../backend/shared-files/config.js';

// Run inside the API container with its existing environment and persistent
// mounts. --apply removes credential bodies from historical audit records;
// history keeps operation metadata only. This command performs no DDL.
try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply') || args.length > 1) throw new Error('Usage: pnpm exec tsx scripts/migrate-native-credentials.ts [--apply]');
if (!process.env.MYSQL_URL) throw new Error('MYSQL_URL is required');
const shared = await loadSharedMountConfig();
if (!shared) throw new Error('Native credential migration requires the mounted persistent debug HOME directory');
const root = resolve('/app/shared/runtime/debug-homes');
const pool = createPool({ uri: process.env.MYSQL_URL, connectionLimit: 2 });
try {
  if (args.includes('--apply')) {
    const files = new NativeSecretFiles(root, new SecretCrypto(process.env.COCELL_SECRET_MASTER_KEY ?? ''));
    const repository = new MySqlSecretRepository(pool, files);
    console.log(JSON.stringify({ directory: root, ...await repository.migrateNativeFiles() }));
  } else {
    const [current] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS remaining FROM secrets WHERE ciphertext NOT LIKE 'native:v1:%'");
    const [history] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS remaining FROM secret_versions WHERE ciphertext<>''");
    console.log(JSON.stringify({ dryRun: true, directory: root, currentRemaining: Number(current[0].remaining), historyBodiesRemaining: Number(history[0].remaining) }));
  }
} catch {
  console.error('Native credential migration failed; no credential content displayed. Fix the configuration or native file permissions and rerun to resume.');
  process.exitCode = 1;
} finally { await pool.end(); }
