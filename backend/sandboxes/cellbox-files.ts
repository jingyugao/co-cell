import { posix } from 'node:path';
import type { SandboxHandle } from '@co-cell/sandbox';
import { HttpError } from '../../util/errors.js';
import { MAX_FILE_BYTES, parseWorkspaceFile, READ_SANDBOX_FILE_SCRIPT, SANDBOX_DOCS_DIRECTORY,
  workspaceFileRequest, type WorkspaceFileReadOptions, type WorkspaceFileResult } from '../workspaces/files.js';

const CHUNK_BYTES = 512 * 1024;
const MAX_GUEST_ENV_BYTES = 8192;
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Keep request bytes out of argv. Cellbox guest limits each argv and env value to 8192 bytes.
const script = `process.argv[1]=Buffer.from(process.env.COCELL_FILE_REQUEST,'utf8').toString('base64');\n${READ_SANDBOX_FILE_SCRIPT}`;

/** Read a product workspace file through Cellbox's bounded agent exec API. */
export async function readCellboxWorkspaceFile(
  sandbox: SandboxHandle,
  nodeBinary: string,
  workingDirectory: string,
  absolutePath: string,
  options: WorkspaceFileReadOptions = {},
  sharedDocsDir = SANDBOX_DOCS_DIRECTORY,
): Promise<WorkspaceFileResult> {
  const workingRoot = posix.normalize(workingDirectory).replace(/\/$/, '');
  const docsRoot = posix.normalize(sharedDocsDir).replace(/\/$/, '');
  const normalizedPath = posix.normalize(absolutePath);
  const matchingRoot = [workingRoot, docsRoot].find(root => root && inside(normalizedPath, root));
  const request = workspaceFileRequest(matchingRoot ?? workingDirectory, absolutePath, options);
  if (!matchingRoot) throw new HttpError(403, '只能访问项目工作区和共享文档中的文件');
  const base = { ...request, roots: [workingRoot, docsRoot] };
  if (!posix.isAbsolute(nodeBinary) || /[\x00-\x1f\x7f]/.test(nodeBinary))
    throw new HttpError(500, 'Cellbox Node 路径无效');
  const command = `${quote(nodeBinary)} --input-type=commonjs -e ${quote(script)}`;
  if (Buffer.byteLength(command) > MAX_GUEST_ENV_BYTES) throw new HttpError(500, 'Cellbox 文件读取脚本超过执行限制');

  const run = async (input: typeof base & { metadataOnly?: boolean; offset?: number; length?: number; version?: string }) => {
    const json = JSON.stringify(input);
    if (Buffer.byteLength(json) > MAX_GUEST_ENV_BYTES) throw new HttpError(400, '文件请求路径超过 Cellbox 执行限制');
    const result = await sandbox.commands.run(command, {
      user: 'agent', timeoutMs: 30_000, envs: { COCELL_FILE_REQUEST: json },
    });
    if (Buffer.byteLength(result.stdout) > 1024 * 1024) throw new HttpError(502, '沙箱文件响应超过 Cellbox 输出限制');
    return parseWorkspaceFile(result.stdout);
  };

  const metadata = await run({ ...base, metadataOnly: true });
  const size = metadata.file.size;
  const version = metadata.version;
  if (!version) throw new HttpError(502, '沙箱文件响应缺少版本信息');
  // Preserve the existing metadata preview for large files unless a range was requested.
  if (options.metadataOnly || (options.offset === undefined && size > MAX_FILE_BYTES)) return metadata;

  const offset = options.offset ?? 0;
  const requestedLength = options.length ?? size;
  const length = Math.min(requestedLength, Math.max(0, size - offset));
  const chunks: Buffer[] = [];
  for (let read = 0; read < length || (length === 0 && read === 0);) {
    const chunkLength = length === 0 ? 0 : Math.min(CHUNK_BYTES, length - read);
    const chunk = await run({ ...base, metadataOnly: false, offset: offset + read, length: chunkLength, version });
    if (chunk.version !== version || chunk.file.path !== metadata.file.path || chunk.file.size !== size || chunk.data.length !== chunkLength)
      throw new HttpError(502, '沙箱文件分块响应不一致，请重试');
    chunks.push(chunk.data);
    if (length === 0) break;
    read += chunkLength;
  }
  const data = Buffer.concat(chunks, length);
  return parseWorkspaceFile(JSON.stringify({ path: metadata.file.path, size, version, data: data.toString('base64') }));
}
