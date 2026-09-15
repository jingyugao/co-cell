import { createPool } from 'mysql2/promise';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Hono } from 'hono';
import type { SessionManager } from '../sessions/manager.js';

interface ArchiveEntry { key: string; size: number; createdAt: string; }
interface FileEntry { name: string; type: 'file' | 'directory'; size: number; }

function listTarFiles(archivePath: string): Promise<{ entries: FileEntry[]; rootPrefix: string }> {
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
      // Collapse singleton root directories: when the root level contains exactly
      // one directory and no files, strip it so users do not have to drill through
      // empty intermediate levels (e.g. "home/user/" collapses to reveal workspace/
      // and .codex/ directly).
      let rootPrefix = '';
      if (entries.length > 0) {
        for (;;) {
          const root = entries.filter(e => !e.name.includes('/'));
          const dirs = root.filter(e => e.type === 'directory');
          const files = root.filter(e => e.type === 'file');
          if (files.length > 0 || dirs.length !== 1) break;
          const singleton = dirs[0].name + '/';
          rootPrefix += singleton;
          for (const f of entries) {
            if (f.name.startsWith(singleton)) f.name = f.name.slice(singleton.length);
          }
          // Remove entries that became empty or are the singleton itself
          for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].name === '' || entries[i].name === dirs[0].name) entries.splice(i, 1);
          }
        }
      }
      resolve({ entries, rootPrefix });
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
      const { entries: allFiles, rootPrefix } = await listTarFiles(archivePath);
      const prefix = path ? (path.endsWith('/') ? path : path + '/') : '';
      const filtered = allFiles.filter(f => {
        if (!f.name.startsWith(prefix)) return false;
        if (f.name === path) return false;
        const relative = f.name.slice(prefix.length);
        return !relative.includes('/');
      }).sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name));
      return c.json({ path, rootPrefix, entries: filtered });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  // Read a file from an archive
  app.get('/api/archives/:key/file', async c => {
    const key = c.req.param('key');
    const filePath = c.req.query('path') || '';
    if (!/^[A-Za-z0-9._-]+\.tar\.gz$/.test(key)) return c.json({ error: '无效的归档文件' }, 400);
    if (!filePath) return c.json({ error: '缺少文件路径' }, 400);
    try {
      const archivePath = join(archivesDir, key);
      const { rootPrefix } = await listTarFiles(archivePath);
      const resolvedPath = rootPrefix ? rootPrefix + filePath : filePath;
      const content = await readTarFile(archivePath, resolvedPath);
      const max = 512 * 1024;
      if (content.length > max) return c.json({ path: filePath, content: content.slice(0, max), truncated: true, totalSize: content.length });
      return c.json({ path: filePath, content, truncated: false });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });
}