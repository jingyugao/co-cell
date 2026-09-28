import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { SessionManager } from '../sessions/manager.js';
import { createArchiveReader } from '../archives/reader.js';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import { matchesRemoteArchive } from '../archives/remote.js';

const content = createArchiveReader();

export function installArchiveRoutes(app: Hono, manager: SessionManager) {
  const remoteOwner = (key: string) => manager.listProjects().find(project =>
    project.remoteArchives?.some(reference => reference.id === key));
  const remoteReference = (key: string, versionId?: string): RemoteArchiveRef | null => {
    const owner = remoteOwner(key);
    return owner?.remoteArchives?.find(reference => reference.id === (versionId ?? key)) ?? null;
  };

  async function withArchive<T>(key: string, versionId: string | undefined,
    read: (source: ReturnType<typeof content.artifactFromFile>) => Promise<T>): Promise<T | null> {
    const reference = remoteReference(key, versionId);
    if (!reference) return null;
    const remote = manager.remoteArchives;
    if (!remote?.download) throw new Error('Cellbox 归档浏览不可用');
    if (!Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes < 1
      || reference.sizeBytes > 2 * 1024 * 1024 * 1024) throw new Error('Cellbox 归档超过浏览大小限制');
    const inspected = await remote.inspect(reference);
    if (!matchesRemoteArchive(reference, inspected)) throw new Error('Cellbox 归档与项目记录不符');
    const directory = await mkdtemp(join(tmpdir(), 'cocell-archive-read-'));
    try {
      const path = join(directory, 'archive.tar.gz');
      await remote.download(reference, path);
      if ((await stat(path)).size !== reference.sizeBytes) throw new Error('Cellbox 归档大小不符');
      const archive = content.artifactFromFile({ storagePath: path, sha256: reference.sha256,
        sizeBytes: reference.sizeBytes, createdAt: reference.createdAt });
      await content.validate(archive);
      return await read(archive);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  app.get('/api/archives', c => {
    const result = manager.listProjects().flatMap(project => {
      const archives = (project.remoteArchives ?? []).map(reference => ({ key: reference.id,
        createdAt: reference.createdAt, size: reference.sizeBytes }));
      return archives.length ? [{ projectId: project.id, projectName: project.name,
        latestAt: archives[0].createdAt, count: archives.length, archives }] : [];
    });
    return c.json(result.sort((a, b) => b.latestAt.localeCompare(a.latestAt)));
  });

  app.get('/api/archives/:key/versions', c => {
    const owner = remoteOwner(c.req.param('key'));
    if (!owner) return c.json({ error: '归档不存在' }, 404);
    return c.json((owner.remoteArchives ?? []).map((reference, index, all) => ({
      id: reference.id, version: all.length - index, createdAt: reference.createdAt,
      sizeBytes: reference.sizeBytes, label: `版本 ${all.length - index}`,
    })));
  });

  app.get('/api/archives/:key/files', async c => {
    const path = content.normalizePath(c.req.query('path') || '');
    if (path === null) return c.json({ error: '无效的文件路径' }, 400);
    try {
      const listing = await withArchive(c.req.param('key'), c.req.query('version'), archive => content.listFiles(archive, path));
      if (!listing) return c.json({ error: '归档文件不存在' }, 404);
      return c.json({ path, ...listing });
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });

  app.get('/api/archives/:key/file', async c => {
    const path = content.normalizePath(c.req.query('path') || '');
    if (path === null) return c.json({ error: '无效的文件路径' }, 400);
    if (!path) return c.json({ error: '缺少文件路径' }, 400);
    try {
      const file = await withArchive(c.req.param('key'), c.req.query('version'), archive => content.readFile(archive, path));
      if (!file) return c.json({ error: '归档文件不存在' }, 404);
      return c.json({ path, ...file });
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });

  app.post('/api/archives/prune', async c => {
    try {
      const deleted = await manager.pruneArchivedProjectArchives();
      return c.json({ deleted, message: `已清理 ${deleted} 个旧归档` });
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });
}
