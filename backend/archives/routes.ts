import { createPool } from 'mysql2/promise';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Hono } from 'hono';
import type { SessionManager } from '../sessions/manager.js';

interface ArchiveEntry { key: string; size: number; createdAt: string; }
interface FileEntry { name: string; type: 'file' | 'directory'; size: number; mtime?: string; }

/**
 * 解析 tar -tvzf 输出的行格式：
 * -rw-r--r-- 1000/1000      128 2026-09-14 11:25 home/user/workspace/.gitignore
 * drwxr-xr-x 0/0               0 2026-09-14 11:26 home/user/workspace/
 */
function parseTarLine(line: string): { name: string; type: 'file' | 'directory'; size: number; mtime?: string } | null {
  // tar verbose output: permission owner/group size date time name
  const re = /^(\S+)\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/;
  const m = line.match(re);
  if (!m) return null;
  const isDir = m[1].startsWith('d');
  const size = Number(m[2]);
  const mtime = `${m[3]}T${m[4]}:00`;
  let name = m[5].replace(/\/$/, '');
  return { name, type: isDir ? 'directory' : 'file', size: isDir ? 0 : size, mtime };
}

function listTarFiles(archivePath: string): Promise<{ entries: FileEntry[]; rootPrefix: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tvzf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `tar exited ${code}`));
      const entries: FileEntry[] = [];
      const dirs = new Set<string>();
      for (const line of stdout.trim().split('\n')) {
        if (!line) continue;
        const parsed = parseTarLine(line);
        if (!parsed) continue;
        const { name, type, size, mtime } = parsed;
        if (type === 'directory') { dirs.add(name); entries.push({ name, type: 'directory', size: 0, mtime }); }
        else {
          const parts = name.split('/');
          for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/');
            if (!dirs.has(parent)) { dirs.add(parent); entries.push({ name: parent, type: 'directory', size: 0 }); }
          }
          entries.push({ name, type: 'file', size, mtime });
        }
      }
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

  /** 解析归档标识为物理文件路径 */
  async function resolvePath(key: string): Promise<string | null> {
    // 旧方案：key = .tar.gz 文件名
    if (/^[A-Za-z0-9._-]+\.tar\.gz$/.test(key)) {
      const path = join(archivesDir, key);
      try { await import('node:fs/promises').then(fs => fs.access(path)); return path; }
      catch { return null; }
    }
    // 新方案：key = 归档流 key，取最新版本
    if (manager.archiveManager) {
      const latest = await manager.archiveManager.getLatest(key);
      if (latest) return latest.storagePath;
    }
    return null;
  }

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

  /** 新方案：列出归档流的所有版本（按版本倒序） */
  app.get('/api/archives/:key/versions', async c => {
    const key = c.req.param('key');
    if (!manager.archiveManager) return c.json({ error: '归档模块未启用' }, 503);
    try {
      const versions = await manager.archiveManager.listVersions(key);
      return c.json(versions.map(v => ({
        id: v.id, version: v.version, isLatest: v.isLatest,
        sizeBytes: v.sizeBytes, sha256: v.sha256,
        createdAt: v.createdAt,
        metadata: v.metadata,
      })));
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  // Browse files inside an archive
  app.get('/api/archives/:key/files', async c => {
    const key = c.req.param('key');
    const path = c.req.query('path') || '';
    const archivePath = await resolvePath(key);
    if (!archivePath) return c.json({ error: '归档文件不存在' }, 404);
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
    if (!filePath) return c.json({ error: '缺少文件路径' }, 400);
    const archivePath = await resolvePath(key);
    if (!archivePath) return c.json({ error: '归档文件不存在' }, 404);
    try {
      const { rootPrefix } = await listTarFiles(archivePath);
      const resolvedPath = rootPrefix ? rootPrefix + filePath : filePath;
      const content = await readTarFile(archivePath, resolvedPath);
      const max = 512 * 1024;
      if (content.length > max) return c.json({ path: filePath, content: content.slice(0, max), truncated: true, totalSize: content.length });
      return c.json({ path: filePath, content, truncated: false });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  // 对所有已归档项目清理旧归档，每项目只保留最新一份
  app.post('/api/archives/prune', async c => {
    try {
      const deleted = await manager.pruneArchivedProjectArchives();
      return c.json({ deleted, message: `已清理 ${deleted} 个旧归档` });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });
}