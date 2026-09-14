import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Hono } from 'hono';
import type { SessionManager } from '../sessions/manager.js';
import { createPool } from 'mysql2/promise';

interface ArchiveEntry { key: string; size: number; createdAt: string; }
interface FileEntry { name: string; type: 'file' | 'directory'; size: number; }

function listTarFiles(archivePath: string): Promise<FileEntry[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tzf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `tar exited ${code}`));
      const entries: FileEntry[] = [];
      const dirs = new Set<string>();
      for (const line of stdout.trim().split('\n')) {
        if (!line) continue;
        const name = line.replace(/\/$/, '');
        if (line.endsWith('/')) { dirs.add(name); entries.push({ name, type: 'directory', size: 0 }); }
        else {
          const parts = name.split('/');
          for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/');
            if (!dirs.has(parent)) { dirs.add(parent); entries.push({ name: parent, type: 'directory', size: 0 }); }
          }
          entries.push({ name, type: 'file', size: 0 });
        }
      }
      resolve(entries);
    });
  });
}

function readTarFile(archivePath: string, filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-O', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `tar exited ${code}`));
      resolve(stdout);
    });
  });
}

export function installArchiveRoutes(app: Hono, manager: SessionManager) {
  const archivesDir = resolve(join(manager.dataDirectory, '..', 'sandbox-data-archives'));
  const mysqlUrl = process.env.MYSQL_URL;

  // List all projects with their archive summaries
  app.get('/api/archives', async c => {
    if (!mysqlUrl) return c.json([]);
    const pool = createPool(mysqlUrl);
    try {
      const [rows] = await pool.query(`
        SELECT a.project_id, a.archive_key, a.size_bytes, a.created_at, p.name as project_name
        FROM project_sandbox_archives a
        JOIN projects p ON a.project_id = p.id
        ORDER BY a.created_at DESC LIMIT 200
      `) as [any[], any];
      const grouped: Record<string, { projectName: string; latestAt: string; count: number; archives: ArchiveEntry[] }> = {};
      for (const row of rows) {
        const pid = row.project_id;
        const createdAt = typeof row.created_at?.toISOString === 'function' ? row.created_at.toISOString() : String(row.created_at ?? '');
        if (!grouped[pid]) grouped[pid] = { projectName: row.project_name, latestAt: createdAt, count: 0, archives: [] };
        grouped[pid].count++;
        if (createdAt > grouped[pid].latestAt) grouped[pid].latestAt = createdAt;
        grouped[pid].archives.push({ key: row.archive_key, size: Number(row.size_bytes), createdAt });
      }
      const result = Object.entries(grouped).map(([projectId, g]) => ({ projectId, ...g }));
      result.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
      return c.json(result);
    } finally { await pool.end(); }
  });

  // Browse files inside an archive
  app.get('/api/archives/:key/files', async c => {
    const key = c.req.param('key');
    const path = c.req.query('path') || '';
    if (!/^[A-Za-z0-9._-]+\.tar\.gz$/.test(key)) return c.json({ error: '无效的归档文件' }, 400);
    const archivePath = join(archivesDir, key);
    try {
      const allFiles = await listTarFiles(archivePath);
      const prefix = path ? (path.endsWith('/') ? path : path + '/') : '';
      const filtered = allFiles.filter(f => {
        if (!f.name.startsWith(prefix)) return false;
        if (f.name === path) return false;
        const relative = f.name.slice(prefix.length);
        return !relative.includes('/');
      }).sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name));
      return c.json({ path, entries: filtered });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  // Read a file from an archive
  app.get('/api/archives/:key/file', async c => {
    const key = c.req.param('key');
    const path = c.req.query('path') || '';
    if (!/^[A-Za-z0-9._-]+\.tar\.gz$/.test(key)) return c.json({ error: '无效的归档文件' }, 400);
    if (!path) return c.json({ error: '缺少文件路径' }, 400);
    try {
      const content = await readTarFile(join(archivesDir, key), path);
      const max = 512 * 1024;
      if (content.length > max) return c.json({ path, content: content.slice(0, max), truncated: true, totalSize: content.length });
      return c.json({ path, content, truncated: false });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });
}