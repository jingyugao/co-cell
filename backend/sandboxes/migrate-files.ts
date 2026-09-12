import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Sandbox } from 'e2b';
import type { SandboxDataArchive } from '../../protocol/sandbox-types.js';
import type { SandboxArchiveStorage } from './archive-storage.js';

const USER_HOME = '/home/user';
const CODEX_HOME = `${USER_HOME}/.codex`;
const IMAGES = `${USER_HOME}/.codex-web/images`;
const COMMAND_TIMEOUT_MS = 3 * 60 * 60 * 1000;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function validateWorkingDirectory(value: string): string {
  if (!value || value.includes('\0') || !posix.isAbsolute(value)) throw new Error('Sandbox working directory must be an absolute path');
  const normalized = posix.normalize(value).replace(/\/$/, '');
  if (normalized === USER_HOME || !normalized.startsWith(`${USER_HOME}/`)
    || normalized === CODEX_HOME || normalized.startsWith(`${CODEX_HOME}/`)
    || normalized === `${USER_HOME}/.codex-web` || normalized.startsWith(`${USER_HOME}/.codex-web/`)) {
    throw new Error('Sandbox working directory must be a separate directory below /home/user');
  }
  return normalized;
}

function validateThreadIds(values: string[]): string[] {
  const result = [...new Set(values)];
  for (const value of result) if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) {
    throw new Error(`Invalid Codex thread ID: ${value}`);
  }
  return result;
}

function pythonManifest(roots: string) {
  return String.raw`import hashlib, json, os, stat, sys
roots=json.loads(${JSON.stringify(roots)})
excluded={'/home/user/.codex/AGENTS.md', '/home/user/.codex/docs'}
h=hashlib.sha256()
for root in roots:
    if not os.path.lexists(root):
        continue
    stack=[root]
    while stack:
        path=stack.pop()
        if path in excluded or path.startswith('/home/user/.codex/docs/'):
            continue
        st=os.lstat(path)
        rel=path.lstrip('/')
        mode=stat.S_IMODE(st.st_mode)
        if stat.S_ISDIR(st.st_mode):
            kind='d'; payload=''
            with os.scandir(path) as entries:
                children=sorted((entry.path for entry in entries), reverse=True)
            stack.extend(children)
        elif stat.S_ISREG(st.st_mode):
            kind='f'
            digest=hashlib.sha256()
            with open(path, 'rb', buffering=0) as source:
                while block := source.read(1024 * 1024): digest.update(block)
            payload=f'{st.st_size}:{digest.hexdigest()}'
        elif stat.S_ISLNK(st.st_mode):
            kind='l'; payload=os.readlink(path)
        else:
            # Sockets, devices and pipes are runtime state, not persistent files.
            continue
        h.update(json.dumps([rel, kind, mode, payload], ensure_ascii=True, separators=(',', ':')).encode() + b'\n')
print(h.hexdigest())`;
}

function preflightScript(workingDirectory: string, roots: string[], threadIds: string[], archive: string, manifest: string, skipProcessCheck = false) {
  const rootJson = JSON.stringify(roots);
  const threadJson = JSON.stringify(threadIds);
  const manifestProgram = pythonManifest(rootJson);
  return String.raw`set -euo pipefail
umask 077
test -d ${quote(workingDirectory)} && test ! -L ${quote(workingDirectory)}
test -d ${quote(CODEX_HOME)} && test ! -L ${quote(CODEX_HOME)}
test ! -L ${quote(IMAGES)} || test ! -e ${quote(IMAGES)}
python3 - ${quote(rootJson)} <<'PY'
import json, os, stat, sys
roots=json.loads(sys.argv[1])
for path in roots:
    current='/'
    for part in path.strip('/').split('/'):
        current=os.path.join(current, part)
        if not os.path.lexists(current): break
        if stat.S_ISLNK(os.lstat(current).st_mode): raise RuntimeError('迁移源路径包含符号链接: ' + current)
def ancestors(pid):
    result=set()
    while pid > 1 and pid not in result:
        result.add(pid)
        try:
            status=open(f'/proc/{pid}/status').read().splitlines()
            pid=int(next(line for line in status if line.startswith('PPid:')).split()[1])
        except (FileNotFoundError, PermissionError, StopIteration, ValueError): break
    return result
ignored=ancestors(os.getpid())
def readonly_plugin_probe(pid):
    # Codex can leave its read-only bundled-plugin version probe behind when
    # GitHub is slow. It does not write a checkout and must not block migration.
    # Permit only this known HTTPS ls-remote tree, not arbitrary Git commands.
    command=open(f'/proc/{pid}/comm').read().strip()
    if command not in ('git', 'git-remote-http', 'git-remote-htt'): return False
    expected=[b'git', b'-c', b'safe.bareRepository=explicit', b'ls-remote', b'https://github.com/openai/plugins.git', b'HEAD']
    for parent in ancestors(pid):
        try:
            args=open(f'/proc/{parent}/cmdline', 'rb').read().rstrip(b'\0').split(b'\0')
            if args == expected: return True
        except (FileNotFoundError, PermissionError): pass
    return False
for entry in os.scandir('/proc'):
    if not entry.name.isdigit() or int(entry.name) in ignored: continue
    try:
        if os.stat(entry.path).st_uid != os.getuid(): continue
        status=open(entry.path + '/status').read().splitlines()
        state=next(line for line in status if line.startswith('State:')).split()[1]
        # Exited children may await reaping by the sandbox init process. They
        # have no executable state or open files and cannot change the snapshot.
        if state in ('Z', 'X'): continue
        if not ${skipProcessCheck ? 'True' : 'False'} and not readonly_plugin_probe(int(entry.name)):
            command=open(entry.path + '/comm').read().strip()
            raise RuntimeError(f'沙箱仍有后台用户进程，迁移前请先停止: {entry.name} {command}')
        for fd in os.scandir(entry.path + '/fd'):
            try:
                flags=int(open(entry.path + '/fdinfo/' + fd.name).read().split('flags:',1)[1].strip().splitlines()[0], 8)
                if flags & 3 == 0: continue
                target=os.path.realpath(fd.path)
                if any(target == root or target.startswith(root + '/') for root in roots):
                    raise RuntimeError(f'进程 {entry.name} 正在写入待迁移目录，请先停止')
            except (FileNotFoundError, PermissionError, IndexError): pass
    except (FileNotFoundError, PermissionError): pass
PY
python3 - ${quote(threadJson)} <<'PY'
import json, os, sys
for thread in json.loads(sys.argv[1]):
    found=False
    for tree in ('sessions', 'archived_sessions'):
        root='/home/user/.codex/' + tree
        if not os.path.isdir(root) or os.path.islink(root): continue
        for base, dirs, files in os.walk(root, followlinks=False):
            dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(base,d))]
            for name in files:
                if name != thread + '.jsonl' and not name.endswith('-' + thread + '.jsonl'): continue
                path=os.path.join(base, name)
                try:
                    fd=os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(fd, 'rb') as record:
                        first=record.readline(1024 * 1024)
                    value=json.loads(first)
                    if value.get('type') == 'session_meta' and value.get('payload', {}).get('id') == thread:
                        found=True; break
                except (OSError, ValueError): pass
            if found: break
        if found: break
    if not found: raise RuntimeError('找不到 Codex 原生会话记录: ' + thread)
PY
python3 - <<'PY' > ${quote(manifest)}
${manifestProgram}
PY
python3 - ${quote(rootJson)} ${quote(archive)} <<'PY'
import json, os, stat, sys, tarfile
roots=json.loads(sys.argv[1]); destination=sys.argv[2]
excluded={'/home/user/.codex/AGENTS.md', '/home/user/.codex/docs'}
def filt(info):
    absolute='/' + info.name.lstrip('./')
    if absolute in excluded or absolute.startswith('/home/user/.codex/docs/') or not (info.isfile() or info.isdir() or info.issym() or info.islnk()): return None
    return info
with tarfile.open(destination, 'w:gz', dereference=False) as archive:
    for root in roots:
        if os.path.lexists(root): archive.add(root, arcname=root.lstrip('/'), recursive=True, filter=filt)
os.chmod(destination, stat.S_IRUSR | stat.S_IWUSR)
PY
cat ${quote(manifest)}
sha256sum ${quote(archive)} | awk '{print $1}'`;
}

function installScript(workingDirectory: string, roots: string[], archive: string) {
  const allowedJson = JSON.stringify(roots.map(root => root.slice(1)));
  const manifestProgram = pythonManifest(JSON.stringify(roots));
  const staging = `/tmp/swarm-hive-migrate-stage-${randomUUID()}`;
  return String.raw`set -euo pipefail
umask 077
test ! -L ${quote(workingDirectory)} || test ! -e ${quote(workingDirectory)}
test ! -L ${quote(CODEX_HOME)}
test ! -L ${quote(IMAGES)} || test ! -e ${quote(IMAGES)}
python3 - ${quote(JSON.stringify(roots))} <<'PY'
import json, os, stat, sys
for path in json.loads(sys.argv[1]):
    current='/'
    for part in path.strip('/').split('/'):
        current=os.path.join(current, part)
        if not os.path.lexists(current): break
        if stat.S_ISLNK(os.lstat(current).st_mode): raise RuntimeError('迁移目标路径包含符号链接: ' + current)
PY
test ! -e ${quote(staging)}
mkdir ${quote(staging)}
trap ${quote(`rm -rf -- ${staging}`)} EXIT
python3 - ${quote(archive)} ${quote(staging)} ${quote(allowedJson)} <<'PY'
import json, os, posixpath, sys, tarfile
archive_path, staging, allowed_arg=sys.argv[1:]
allowed=json.loads(allowed_arg)
def within(name): return any(name == root or name.startswith(root + '/') for root in allowed)
with tarfile.open(archive_path, 'r:gz') as archive:
    members=archive.getmembers(); links=set(); names=set(); normalized=[]
    for member in members:
        name=posixpath.normpath(member.name).lstrip('/')
        if member.name.startswith('/') or name in ('', '.', '..') or name.startswith('../') or not within(name): raise RuntimeError('迁移档案包含不安全路径: ' + member.name)
        if name in names: raise RuntimeError('迁移档案包含重复路径: ' + member.name)
        names.add(name); normalized.append((member, name))
        if member.issym(): links.add(name)
        elif not (member.islnk() or member.isdir() or member.isfile()): raise RuntimeError('迁移档案包含不支持的文件类型: ' + member.name)
    regulars={name for member, name in normalized if member.isfile()}
    for member, name in normalized:
        parts=name.split('/')
        if any('/'.join(parts[:i]) in links for i in range(1, len(parts))): raise RuntimeError('迁移档案路径穿过符号链接: ' + member.name)
        if member.islnk():
            target=posixpath.normpath(member.linkname).lstrip('/')
            target_parts=target.split('/')
            if member.linkname.startswith('/') or target.startswith('../') or target not in regulars or not within(target) or any('/'.join(target_parts[:i]) in links for i in range(1, len(target_parts))): raise RuntimeError('迁移档案包含不安全的硬链接: ' + member.name)
    archive.extractall(staging, filter='fully_trusted')
PY
mkdir -p ${quote(posix.dirname(workingDirectory))} ${quote(CODEX_HOME)} ${quote(posix.dirname(IMAGES))}
rm -rf -- ${quote(workingDirectory)}
cp -a ${quote(`${staging}${workingDirectory}`)} ${quote(workingDirectory)}
find ${quote(CODEX_HOME)} -mindepth 1 -maxdepth 1 ! -name AGENTS.md ! -name docs -exec rm -rf -- {} +
if test -d ${quote(`${staging}${CODEX_HOME}`)}; then cp -a ${quote(`${staging}${CODEX_HOME}/.`)} ${quote(`${CODEX_HOME}/`)}; fi
rm -rf -- ${quote(IMAGES)}
if test -d ${quote(`${staging}${IMAGES}`)}; then cp -a ${quote(`${staging}${IMAGES}`)} ${quote(IMAGES)}; fi
rm -rf -- ${quote(staging)}
sha256sum ${quote(archive)} | awk '{print $1}'
python3 - <<'PY'
${manifestProgram}
PY`;
}

/** @internal Test seam for executing the generated shell programs without E2B. */
export const sandboxMigrationScriptTestSupport = { preflightScript, installScript };

const command = async (sandbox: Sandbox, script: string, stage: string, signal: AbortSignal) => {
  try {
    return await sandbox.commands.run(`bash -c ${quote(script)}`, {
      user: 'user', signal, timeoutMs: COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    // CommandExitError.message only says "exit status 1". Surface the final
    // diagnostic line, never SDK request headers or archived file contents.
    const stderr = (error as { stderr?: unknown })?.stderr;
    const detail = typeof stderr === 'string' ? stderr.trim().split('\n').at(-1)?.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300) : '';
    throw new Error(`${stage}失败${detail ? `：${detail}` : '，请检查沙箱连接及磁盘空间'}`);
  }
};

function parseVerification(stdout: string, stage: string): [string, string] {
  const [first, second] = stdout.trim().split(/\s+/);
  if (!/^[a-f\d]{64}$/.test(first ?? '') || !/^[a-f\d]{64}$/.test(second ?? '')) {
    throw new Error(`${stage}返回了无效的校验数据`);
  }
  return [first, second];
}

/** Archives persistent project and Codex state from an idle sandbox. */
export async function archiveSandboxFiles(
  source: Sandbox,
  workingDirectory: string,
  threadIds: string[],
  storage: SandboxArchiveStorage,
  signal: AbortSignal,
): Promise<SandboxDataArchive> {
  const workspace = validateWorkingDirectory(workingDirectory);
  const threads = validateThreadIds(threadIds);
  signal.throwIfAborted();

  const token = randomUUID();
  const sourceArchive = `/tmp/swarm-hive-data-${token}.tar.gz`;
  const sourceManifest = `/tmp/swarm-hive-migrate-${token}.manifest`;
  const roots = [workspace, CODEX_HOME, IMAGES];
  let stored: Awaited<ReturnType<SandboxArchiveStorage['put']>> | undefined;
  try {
    const prepared = await command(source,
      preflightScript(workspace, roots, threads, sourceArchive, sourceManifest), '源沙箱文件预检查和打包', signal);
    const [beforeManifest, sourceHash] = parseVerification(prepared.stdout, '源沙箱文件预检查和打包');

    const stream = await source.files.read(sourceArchive, {
      user: 'user', format: 'stream', signal, requestTimeoutMs: 60_000, streamIdleTimeoutMs: 60_000,
    });
    stored = await storage.put(Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]));
    if (stored.sha256 !== sourceHash) throw new Error('Sandbox data archive checksum mismatch');

    const afterScript = String.raw`set -euo pipefail
sha256sum ${quote(sourceArchive)} | awk '{print $1}'
python3 - <<'PY'
${pythonManifest(JSON.stringify(roots))}
PY`;
    const after = await command(source, afterScript, '源沙箱一致性检查', signal);
    const [afterHash, afterManifest] = parseVerification(after.stdout, '源沙箱一致性检查');
    if (afterHash !== sourceHash || afterManifest !== beforeManifest) throw new Error('Source sandbox changed during archiving');

    return {
      ...stored,
      format: 'codex-workspace-v1',
      workingDirectory: workspace,
      threadIds: threads,
      manifestSha256: beforeManifest,
      sourceSandboxId: source.sandboxId,
    };
  } catch (error) {
    if (stored) await Promise.allSettled([storage.delete(stored)]);
    throw error;
  } finally {
    await Promise.allSettled([source.commands.run(`rm -f -- ${quote(sourceArchive)} ${quote(sourceManifest)}`, {
      user: 'user', timeoutMs: 30_000,
    })]);
  }
}

/** Restores an archived workspace and Codex state without accessing its source sandbox. */
export async function restoreSandboxFiles(
  target: Sandbox,
  archive: SandboxDataArchive,
  storage: SandboxArchiveStorage,
  signal: AbortSignal,
): Promise<void> {
  if (archive.format !== 'codex-workspace-v1') throw new Error('Unsupported sandbox data archive format');
  const workspace = validateWorkingDirectory(archive.workingDirectory);
  validateThreadIds(archive.threadIds);
  if (!/^[a-f\d]{64}$/.test(archive.manifestSha256)) throw new Error('Sandbox data archive manifest is invalid');
  signal.throwIfAborted();

  const hostDirectory = await mkdtemp(join(tmpdir(), 'swarm-hive-data-'));
  await chmod(hostDirectory, 0o700);
  const hostArchive = join(hostDirectory, 'archive.tar.gz');
  const targetArchive = `/tmp/swarm-hive-data-${randomUUID()}.tar.gz`;
  const roots = [workspace, CODEX_HOME, IMAGES];
  try {
    await storage.get(archive, hostArchive);
    signal.throwIfAborted();
    const file = createReadStream(hostArchive);
    try {
      await target.files.write(targetArchive, Readable.toWeb(file) as ReadableStream<Uint8Array>, {
        user: 'user', signal, requestTimeoutMs: 0,
      });
    } catch (error) {
      file.destroy();
      throw error;
    }
    const installed = await command(target, installScript(workspace, roots, targetArchive), '新沙箱文件解包和校验', signal);
    const [targetHash, targetManifest] = parseVerification(installed.stdout, '新沙箱文件解包和校验');
    if (targetHash !== archive.sha256) throw new Error('Sandbox data archive checksum mismatch');
    if (targetManifest !== archive.manifestSha256) throw new Error('Sandbox data archive content verification failed');
  } finally {
    await Promise.allSettled([
      rm(hostDirectory, { recursive: true, force: true }),
      target.commands.run(`rm -f -- ${quote(targetArchive)}`, { user: 'user', timeoutMs: 30_000 }),
    ]);
  }
}
