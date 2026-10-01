import { posix } from 'node:path';
import { CellboxError, type SandboxHandle } from '@co-cell/sandbox';
import { HttpError } from '../../util/errors.js';
import { workspaceFileResult, type WorkspaceFileResult } from '../workspaces/files.js';

/** Read workspace bytes through Cellbox's native file API. */
export async function readCellboxWorkspaceFile(
  sandbox: SandboxHandle,
  workingDirectory: string,
  absolutePath: string,
): Promise<WorkspaceFileResult> {
  if (!absolutePath || absolutePath.length > 4096 || !posix.isAbsolute(absolutePath)
      || /[\x00-\x1f\x7f]/.test(absolutePath) || absolutePath.split('/').includes('..')) {
    throw new HttpError(400, '文件地址必须是工作区内的绝对路径');
  }
  const root = posix.normalize(workingDirectory);
  const path = posix.normalize(absolutePath);
  const relative = posix.relative(root, path);
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative))
    throw new HttpError(403, '只能访问项目工作区中的文件');
  try {
    return workspaceFileResult(path, await sandbox.files.readBytes(path, { user: 'agent' }));
  } catch (error) {
    if (error instanceof CellboxError) {
      if (error.code === 'INVALID_REQUEST' && /exceeds.*(?:limit|bytes)/i.test(error.message))
        throw new HttpError(413, '文件超过 16 MiB，无法读取');
      if (error.code === 'NOT_FOUND') throw new HttpError(404, '文件不存在或无法访问');
      if (error.code === 'FORBIDDEN') throw new HttpError(403, '没有权限读取此文件');
      if (error.code === 'INVALID_REQUEST') throw new HttpError(400, '文件路径无效或不是普通文件');
    }
    throw error;
  }
}
