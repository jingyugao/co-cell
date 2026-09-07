import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Changes, GitChange } from '../../shared/types.js';

const exec = promisify(execFile);
export async function getChanges(directory: string): Promise<Changes> {
  const git = async (args: string[]) => (await exec('git', args, {
    cwd: directory, maxBuffer: 2 * 1024 * 1024, timeout: 15_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
  })).stdout;
  try {
    const [status, branch] = await Promise.all([
      git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => 'detached HEAD'),
    ]);
    const records = status.split('\0');
    const files: GitChange[] = [];
    for (let i = 0; i < records.length; i++) {
      if (!records[i]) continue;
      const code = records[i].slice(0, 2);
      files.push({ status: code.trim(), path: records[i].slice(3) });
      if (/[RC]/.test(code)) i++;
    }
    let diff: string;
    try { diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', '.']); }
    catch {
      const [unstaged, staged] = await Promise.all([
        git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', '.']),
        git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--', '.']),
      ]);
      diff = staged + unstaged;
    }
    return { branch: branch.trim(), files, diff };
  } catch (error) {
    return { branch: '', files: [], diff: '', error: error instanceof Error ? error.message : '无法读取 Git 变更' };
  }
}
