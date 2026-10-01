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
  const path = workspaceFilePath(workingDirectory, absolutePath);
  try {
    return workspaceFileResult(path, await sandbox.files.readBytes(path, { user: 'agent' }));
  } catch (error) { throw fileError(error); }
}

export async function cellboxWorkspaceFileResponse(sandbox: SandboxHandle, workingDirectory: string,
  absolutePath: string, request: Request): Promise<Response> {
  const path = workspaceFilePath(workingDirectory, absolutePath);
  if (!sandbox.files.readResponse) throw new HttpError(503, 'Sandbox 文件流接口未配置');
  try {
    return await sandbox.files.readResponse(path, { user: 'agent', method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: request.headers, signal: request.signal });
  } catch (error) { throw fileError(error); }
}

function workspaceFilePath(workingDirectory: string, absolutePath: string): string {
  if (!absolutePath || absolutePath.length > 4096 || !posix.isAbsolute(absolutePath)
      || /[\x00-\x1f\x7f]/.test(absolutePath) || absolutePath.split('/').includes('..')) {
    throw new HttpError(400, '文件地址必须是工作区内的绝对路径');
  }
  const root = posix.normalize(workingDirectory);
  const path = posix.normalize(absolutePath);
  const relative = posix.relative(root, path);
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative))
    throw new HttpError(403, '只能访问项目工作区中的文件');
  return path;
}

function fileError(error: unknown): unknown {
  if (error instanceof CellboxError) {
    if (error.code === 'INVALID_REQUEST' && /exceeds.*(?:limit|bytes)/i.test(error.message))
      return new HttpError(413, '文件超过 16 MiB，无法读取');
    if (error.code === 'NOT_FOUND') return new HttpError(404, '文件不存在或无法访问');
    if (error.code === 'FORBIDDEN') return new HttpError(403, '没有权限读取此文件');
    if (error.code === 'INVALID_REQUEST') return new HttpError(400, '文件路径无效或不是普通文件');
  }
  return error;
}
