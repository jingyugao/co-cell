import { join, resolve } from 'node:path';
import type { Hono } from 'hono';
import type { SessionManager } from '../sessions/manager.js';
import { createArchiveReader, type ArchiveService } from '@co-cell/archives';

type ArchiveSource = Parameters<ArchiveService['listFiles']>[0];

interface ArchiveEntry { key: string; size: number; createdAt: string; bytesAdded?: number; }

export function installArchiveRoutes(app: Hono, manager: SessionManager) {
  const archivesDir = resolve(join(manager.dataDirectory, '..', 'sandbox-data-archives'));
  const content = manager.archiveManager ?? createArchiveReader();

  /** Resolve either a legacy tar path or the current typed archive version. */
  async function resolveArchive(key: string, versionId?: string): Promise<ArchiveSource | null> {
    // 旧方案：key = .tar.gz 文件名
    if (!versionId && /^[A-Za-z0-9._-]+\.tar\.gz$/.test(key)) {
      const path = join(archivesDir, key);
      try { await import('node:fs/promises').then(fs => fs.access(path)); return content.sourceFromFile(path); }
      catch { return null; }
    }
    // 新方案：key = 归档流 key，取最新版本
    if (manager.archiveManager) {
      const latest = versionId ? await manager.archiveManager.getVersion(key, versionId) : await manager.archiveManager.getLatest(key);
      if (latest) return latest;
    }
    return null;
  }

  // List all projects with their archive summaries
  app.get('/api/archives', async c => {
    const result: Array<{ projectId: string; projectName: string; latestAt: string; count: number; archives: ArchiveEntry[] }> = [];
    for (const project of manager.listProjects()) {
      let archives: ArchiveEntry[] = [];
      if (project.archiveKey && manager.archiveManager) {
        const versions = await manager.archiveManager.listVersions(project.archiveKey);
        archives = versions.map(version => { const details = manager.archiveManager!.describe(version);
          return { key: project.archiveKey!, createdAt: details.createdAt, size: details.sizeBytes,
            ...(details.bytesAdded === undefined ? {} : { bytesAdded: details.bytesAdded }) }; });
      } else if (project.sandboxDataArchive) {
        archives = [{ key: project.sandboxDataArchive.key, size: project.sandboxDataArchive.sizeBytes,
          createdAt: project.sandboxDataArchive.createdAt }];
      }
      if (archives.length) result.push({ projectId: project.id, projectName: project.name,
        latestAt: archives[0].createdAt, count: archives.length, archives });
    }
    return c.json(result.sort((a, b) => b.latestAt.localeCompare(a.latestAt)));
  });

  /** 新方案：列出归档流的所有版本（按版本倒序） */
  app.get('/api/archives/:key/versions', async c => {
    const key = c.req.param('key');
    if (!manager.archiveManager) return c.json({ error: '归档模块未启用' }, 503);
    try {
      const versions = await manager.archiveManager.listVersions(key);
      return c.json(versions.map(v => manager.archiveManager!.describe(v)));
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  // Browse files inside an archive
  app.get('/api/archives/:key/files', async c => {
    const key = c.req.param('key');
    const path = content.normalizePath(c.req.query('path') || '');
    if (path === null) return c.json({ error: '无效的文件路径' }, 400);
    const archive = await resolveArchive(key, c.req.query('version'));
    if (!archive) return c.json({ error: '归档文件不存在' }, 404);
    try {
      return c.json({ path, ...await content.listFiles(archive, path) });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  // Read a file from an archive
  app.get('/api/archives/:key/file', async c => {
    const key = c.req.param('key');
    const requestedPath = c.req.query('path') || '';
    const filePath = content.normalizePath(requestedPath);
    if (filePath === null) return c.json({ error: '无效的文件路径' }, 400);
    if (!filePath) return c.json({ error: '缺少文件路径' }, 400);
    const archive = await resolveArchive(key, c.req.query('version'));
    if (!archive) return c.json({ error: '归档文件不存在' }, 404);
    try {
      return c.json({ path: filePath, ...await content.readFile(archive, filePath) });
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
