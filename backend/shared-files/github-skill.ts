import { EnvHttpProxyAgent, fetch } from 'undici';
import { HttpError } from '../../util/errors.js';
import type { RemoteSkill } from '../../protocol/agent-profile-types.js';

export const skillName = /^[a-z0-9][a-z0-9-]{0,63}$/;
export interface AssetFile {
  path: string;
  bytes: Buffer;
  executable: boolean;
}
export const maxFiles = 512,
  maxBytes = 16 * 1024 * 1024;

const githubConnection = new EnvHttpProxyAgent();

async function download(url: string, limit: number, signal: AbortSignal) {
  const response = await fetch(url, {
    dispatcher: githubConnection,
    redirect: 'error',
    signal,
    headers: { 'User-Agent': 'CoCell-skill-import' },
  }).catch(() => {
    throw new HttpError(502, '无法连接 GitHub，请检查网络或代理后重试');
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new HttpError(422, `GitHub 返回 ${response.status}，请检查公开仓库、版本和目录`);
  }
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new HttpError(413, '远程 skill 超过大小限制');
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(parts);
}
export async function fetchGithubSkill(input: Omit<RemoteSkill, 'commit'>) {
  const url = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/.exec(input.repository);
  if (!url || [url[1], url[2]].some((part) => part.startsWith('.')) || !skillName.test(input.name))
    throw new HttpError(400, '请输入公开 GitHub 仓库地址和有效的 skill 名称');
  const repo = url[1] + '/' + url[2].replace(/\.git$/, '');
  const dir = input.directory.replace(/^\/+|\/+$/g, '');
  if (dir && dir.split('/').some((part) => !part || part.startsWith('.') || /[\\\x00-\x1f]/.test(part)))
    throw new HttpError(400, 'skill 子目录无效');
  const signal = AbortSignal.timeout(60_000);
  const api = async (path: string) =>
    JSON.parse((await download('https://api.github.com/repos/' + repo + path, 8 << 20, signal)).toString());
  const commit = await api('/commits/' + encodeURIComponent(input.ref || 'HEAD'));
  if (!/^[a-f0-9]{40}$/.test(commit.sha) || !/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha))
    throw new HttpError(422, 'GitHub 版本无效');
  // Resolve the selected subtree first, so large sibling directories never enter the import.
  let tree = commit.commit.tree.sha;
  for (const segment of dir ? dir.split('/') : []) {
    const listing = await api('/git/trees/' + tree);
    tree = listing.tree.find((e: { path: string; type: string }) => e.path === segment && e.type === 'tree')?.sha;
    if (!tree) throw new HttpError(422, '找不到指定的 skill 目录');
  }
  const listing = await api('/git/trees/' + tree + '?recursive=1');
  const files: AssetFile[] = [];
  if (listing.truncated) throw new HttpError(413, 'skill 目录过大');
  const entries = listing.tree.filter((e: { type: string }) => e.type !== 'tree');
  if (!entries.some((e: { path: string }) => e.path === 'SKILL.md'))
    throw new HttpError(422, '所选目录需要包含 SKILL.md');
  if (entries.length > maxFiles) throw new HttpError(413, 'skill 文件过多');
  let total = 0;
  for (const entry of entries) {
    if (
      !['100644', '100755'].includes(entry.mode) ||
      entry.path
        .split('/')
        .some(
          (p: string) =>
            !p || ['.', '..', '.git'].includes(p) || p.startsWith('.shared-write-') || /[\\\x00-\x1f]/.test(p),
        )
    )
      throw new HttpError(422, 'skill 包含不支持的路径、符号链接或子模块');
    const path = [dir, entry.path].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/');
    const bytes = await download(
      `https://raw.githubusercontent.com/${repo}/${commit.sha}/${path}`,
      Math.min(4 << 20, maxBytes - total),
      signal,
    );
    total += bytes.length;
    files.push({ path: entry.path, bytes, executable: entry.mode === '100755' });
  }
  return {
    source: { ...input, repository: 'https://github.com/' + repo, directory: dir, commit: commit.sha as string },
    files,
  };
}
