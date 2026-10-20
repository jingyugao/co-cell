import { createHash, randomBytes } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';

const LEGACY_TABLES = [
  'projects',
  'sessions',
  'session_turns',
  'model_runtime_routes',
  'project_tool_grants',
  'project_tool_roles',
  'project_tool_runtimes',
  'sandbox_runtime_configs',
] as const;

const ARCHIVE_SUFFIX = /_legacy_\d{8}T\d{6}Z_[a-z0-9]{6}$/;

interface TableRow extends RowDataPacket { TABLE_NAME: string }
interface ColumnRow extends RowDataPacket { TABLE_NAME: string; COLUMN_NAME: string }
interface ForeignKeyRow extends RowDataPacket {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  REFERENCED_TABLE_NAME: string;
}
interface LockRow extends RowDataPacket { acquired: number | null }

export interface LegacyArchiveResult {
  /** Tables moved together by one atomic RENAME TABLE statement. */
  renamed: Array<{ from: string; to: string }>;
  /** Constraints removed from archived snapshots, including cleanup retries. */
  foreignKeysRemoved: Array<{ table: string; constraint: string }>;
  /** True when there was no old document schema to archive. */
  noOp: boolean;
}

const quoteIdentifier = (identifier: string) => `\`${identifier.replaceAll('`', '``')}\``;

function archiveSuffix(now = new Date()): string {
  const utc = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `_legacy_${utc}_${randomBytes(4).toString('hex').slice(0, 6)}`;
}

/**
 * Preserve the old document-based metadata schema in this database for
 * inspection. This deliberately does not copy or delete rows.
 */
export async function archiveLegacyMetadata(pool: Pool): Promise<LegacyArchiveResult> {
  const connection = await pool.getConnection();
  let lockName: string | undefined;
  let locked = false;
  try {
    const [databaseRows] = await connection.query<Array<RowDataPacket & { database_name: string | null }>>('SELECT DATABASE() AS database_name');
    const databaseName = databaseRows[0]?.database_name;
    if (!databaseName) throw new Error('Cannot archive legacy metadata without a selected MySQL database.');
    lockName = `cocell:legacy:${createHash('sha256').update(databaseName).digest('hex').slice(0, 48)}`;
    const [lockRows] = await connection.query<LockRow[]>('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new Error('Another legacy metadata archive is already running for this database.');
    locked = true;

    const [tableRows] = await connection.query<TableRow[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`);
    const present = new Set(tableRows.map(row => row.TABLE_NAME));
    const [documentColumns] = await connection.query<ColumnRow[]>(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('projects','sessions') AND COLUMN_NAME = 'document'`);
    const hasLegacySchema = documentColumns.some(row => row.COLUMN_NAME === 'document');

    const archivedTables = tableRows.map(row => row.TABLE_NAME).filter(name =>
      LEGACY_TABLES.some(base => name.startsWith(`${base}_legacy_`) && ARCHIVE_SUFFIX.test(name)));
    const renamed: LegacyArchiveResult['renamed'] = [];
    const foreignKeysRemoved: LegacyArchiveResult['foreignKeysRemoved'] = [];

    if (hasLegacySchema) {
      const currentCandidates = LEGACY_TABLES.filter(name => present.has(name));
      const [incomingRows] = currentCandidates.length
        ? await connection.query<ForeignKeyRow[]>(
          `SELECT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME
           FROM information_schema.KEY_COLUMN_USAGE
           WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (${currentCandidates.map(() => '?').join(',')})`,
          currentCandidates)
        : [ [] as ForeignKeyRow[] ];
      const unexpected = incomingRows.filter(row => row.TABLE_SCHEMA !== databaseName
        || !LEGACY_TABLES.includes(row.TABLE_NAME as typeof LEGACY_TABLES[number]));
      if (unexpected.length) {
        const dependencies = unexpected.map(row => `${row.TABLE_SCHEMA}.${row.TABLE_NAME}.${row.CONSTRAINT_NAME} -> ${row.REFERENCED_TABLE_NAME}`).join(', ');
        throw new Error(`Cannot archive legacy metadata because non-legacy tables reference it: ${dependencies}.`);
      }

      let suffix = archiveSuffix();
      let targets = currentCandidates.map(from => ({ from, to: `${from}${suffix}` }));
      while (targets.some(item => present.has(item.to))) {
        suffix = archiveSuffix();
        targets = currentCandidates.map(from => ({ from, to: `${from}${suffix}` }));
      }
      if (targets.length) {
        const renamePairs = targets.map(item => `${quoteIdentifier(item.from)} TO ${quoteIdentifier(item.to)}`).join(', ');
        await connection.query(`RENAME TABLE ${renamePairs}`);
        renamed.push(...targets);
        archivedTables.push(...targets.map(item => item.to));
      }
    }

    // A previous run may have completed the atomic rename but stopped while
    // detaching archived foreign keys. Retry that cleanup without renaming the
    // active relational schema.
    const uniqueArchived = [...new Set(archivedTables)];
    for (const table of uniqueArchived) {
      const [foreignKeys] = await connection.query<Array<RowDataPacket & { CONSTRAINT_NAME: string }>>(
        `SELECT DISTINCT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`, [table]);
      for (const row of foreignKeys) {
        await connection.query(`ALTER TABLE ${quoteIdentifier(table)} DROP FOREIGN KEY ${quoteIdentifier(row.CONSTRAINT_NAME)}`);
        foreignKeysRemoved.push({ table, constraint: row.CONSTRAINT_NAME });
      }
    }

    return { renamed, foreignKeysRemoved, noOp: !hasLegacySchema };
  } finally {
    if (locked && lockName) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
    connection.release();
  }
}
