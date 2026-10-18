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
  const remoteOwner = async (key: string) => (await manager.listArchiveProjects()).find(project =>
    project.remoteArchives?.some(reference => reference.id === key));
  const remoteReference = async (key: string, versionId?: string): Promise<RemoteArchiveRef | null> => {
    const owner = await remoteOwner(key);
    return owner?.remoteArchives?.find(reference => reference.id === (versionId ?? key)) ?? null;
  };

  async function withArchive<T>(reference: RemoteArchiveRef | null,
    read: (source: ReturnType<typeof content.artifactFromFile>) => Promise<T>): Promise<T | null> {
    if (!reference) return null;
    if (reference.storageType === 'cellbox-volume') throw new Error('Cellbox 磁盘备份暂不支持文件浏览');
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

  app.get('/api/archives', async c => {
    const result = (await manager.listArchiveProjects()).flatMap(project => {
      const archives = (project.remoteArchives ?? []).map(reference => ({ key: reference.id,
        createdAt: reference.createdAt, ...(reference.sizeBytes !== undefined ? { size: reference.sizeBytes } : {}),
        ...(reference.storageType === 'cellbox-volume' ? { volumeId: reference.volumeId, snapshotId: reference.snapshotId,
          ...(reference.addedBytes === undefined ? {} : { addedBytes: reference.addedBytes }) } : {}),
        storageType: reference.storageType ?? 'cellbox', browsable: reference.storageType !== 'cellbox-volume' }));
      return archives.length ? [{ projectId: project.id, projectName: project.name,
        latestAt: archives[0].createdAt, count: archives.length, archives }] : [];
    });
    return c.json(result.sort((a, b) => b.latestAt.localeCompare(a.latestAt)));
  });

  app.get('/api/archives/:key/versions', async c => {
    const owner = await remoteOwner(c.req.param('key'));
    if (!owner) return c.json({ error: '归档不存在' }, 404);
    return c.json((owner.remoteArchives ?? []).map((reference, index, all) => ({
      id: reference.id, version: all.length - index, createdAt: reference.createdAt,
      ...(reference.sizeBytes !== undefined ? { sizeBytes: reference.sizeBytes } : {}),
      ...('addedBytes' in reference && reference.addedBytes !== undefined ? { bytesAdded: reference.addedBytes } : {}),
      browsable: reference.storageType !== 'cellbox-volume', storageType: reference.storageType ?? 'cellbox',
      ...(reference.storageType === 'cellbox-volume' ? { volumeId: reference.volumeId, snapshotId: reference.snapshotId } : {}),
      label: `版本 ${all.length - index}`,
    })));
  });

  app.get('/api/archives/:key/files', async c => {
    const reference = await remoteReference(c.req.param('key'), c.req.query('version'));
    if (reference?.storageType === 'cellbox-volume')
      return c.json({ error: 'Cellbox 磁盘备份暂不支持文件浏览' }, 422);
    const path = content.normalizePath(c.req.query('path') || '');
    if (path === null) return c.json({ error: '无效的文件路径' }, 400);
    try {
      const listing = await withArchive(reference, archive => content.listFiles(archive, path));
      if (!listing) return c.json({ error: '归档文件不存在' }, 404);
      return c.json({ path, ...listing });
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });

  app.get('/api/archives/:key/file', async c => {
    const reference = await remoteReference(c.req.param('key'), c.req.query('version'));
    if (reference?.storageType === 'cellbox-volume')
      return c.json({ error: 'Cellbox 磁盘备份暂不支持文件浏览' }, 422);
    const path = content.normalizePath(c.req.query('path') || '');
    if (path === null) return c.json({ error: '无效的文件路径' }, 400);
    if (!path) return c.json({ error: '缺少文件路径' }, 400);
    try {
      const file = await withArchive(reference, archive => content.readFile(archive, path));
      if (!file) return c.json({ error: '归档文件不存在' }, 404);
      return c.json({ path, ...file });
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });

}
