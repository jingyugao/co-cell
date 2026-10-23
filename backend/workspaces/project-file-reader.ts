import { posix } from 'node:path';
import type { CellboxClient } from '../../packages/sandbox/src/providers/cellbox/client.js';
import type { Project } from '../../protocol/types.js';
import type { SandboxMount } from '../../protocol/sandbox-types.js';
import { sandboxMounts } from '../../util/sandbox-mounts.js';
import { HttpError } from '../../util/errors.js';
import { workspaceFilePath } from '../sandboxes/cellbox-files.js';

export type ProjectFileReader = (project: Project, path: string, request: Request) => Promise<Response>;

/** Map the visible file through the most specific persistent mount. */
function mountedFile(mounts: SandboxMount[], path: string) {
  const mount = [...mounts].sort((a, b) => b.mountPath.length - a.mountPath.length).find(mount =>
    path === posix.normalize(mount.mountPath) || path.startsWith(`${posix.normalize(mount.mountPath).replace(/\/$/, '')}/`));
  if (!mount) throw new HttpError(422, '此文件不在持久卷中，无法离线读取');
  const relative = posix.relative(mount.mountPath, path);
  if (!relative) throw new HttpError(400, '请选择文件');
  return { volumeId: mount.volumeId, path: relative };
}

/** Reads do not resume a Box, create a volume or restore the project. */
export function createProjectFileReader(client: CellboxClient, live: ProjectFileReader): ProjectFileReader {
  return async (project, inputPath, request) => {
    const path = workspaceFilePath(project.workingDirectory, inputPath);
    const options = { method: request.method === 'HEAD' ? 'HEAD' as const : 'GET' as const,
      headers: request.headers, signal: request.signal };
    let response: Response;
    let source: 'live' | 'volume' | 'backup';
    let backupCreatedAt: string | undefined;
    if (project.status === 'archived') {
      const backup = [...(project.remoteArchives ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!backup) throw new HttpError(404, '项目没有可读取的归档备份');
      if (backup.storageType !== 'cellbox-volume') throw new HttpError(422, '旧格式归档暂不支持单文件读取，请先恢复项目');
      const file = mountedFile(backup.mounts, path);
      if (file.volumeId !== backup.volumeId) throw new HttpError(422, '归档文件挂载与备份磁盘不一致');
      response = await client.backupFileResponse(backup.volumeId, backup.snapshotId, file.path, options);
      source = 'backup'; backupCreatedAt = backup.createdAt;
    } else {
      const box = project.sandbox ? await client.getBox(project.sandbox.id, request.signal) : undefined;
      if (box?.phase === 'running') {
        response = await live(project, path, request); source = 'live';
      } else {
        if (box && !['suspended', 'failed', 'deleted'].includes(box.phase)) throw new HttpError(409, 'Sandbox 正在切换状态，请稍后重试');
        const mounts = sandboxMounts(box ?? project.sandbox ?? {}) ?? project.sandboxMounts ?? [];
        const file = mountedFile(mounts, path);
        response = await client.volumeFileResponse(file.volumeId, file.path, options); source = 'volume';
      }
    }
    const headers = new Headers(response.headers);
    headers.set('X-CoCell-File-Source', source);
    if (backupCreatedAt) headers.set('X-CoCell-Backup-Created-At', backupCreatedAt);
    return new Response(response.body, { status: response.status, headers });
  };
}
