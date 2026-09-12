import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxArchiveStorage, StoredArchive } from './archive-storage.js';

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const ARTIFACT = /^(?:metadata\.json|snapfile|(?:rootfs\.ext4|memfile)(?:\.header|\.(?:zstd|lz4)(?:\.uncompressed-size)?)?)$/;

interface Snapshot {
  sandboxId: string;
  rootBuildId: string;
  teamId: string;
  templateId: string;
  kernelVersion: string;
  firecrackerVersion: string;
  filesystemOnly: boolean;
}

interface Manifest extends Snapshot {
  version: 1;
  dependencies: string[];
  archivedAt: string;
}

interface Inspection {
  image: { build_id: string; base_build_id: string };
  mappings: { by_build: { build_id: string }[] };
}

/** Local E2B native snapshots: backs up disk AND memory without waking the VM.
 * Source artifacts and E2B database records are deliberately retained.
 * Callers serialize this operation with project execution and verify paused state.
 */
export class LocalSnapshotArchive {
  private readonly storage: SandboxArchiveStorage;
  private readonly directory: string;
  private readonly inspectBinary: string;
  private readonly image: string;

  constructor(options: {
    storage: SandboxArchiveStorage;
    e2bDirectory: string;
    inspectBinary: string;
    dockerImage?: string;
  }) {
    this.storage = options.storage;
    this.directory = resolve(options.e2bDirectory);
    this.inspectBinary = resolve(options.inspectBinary);
    this.image = options.dockerImage ?? 'postgres:18-alpine';
  }

  private async command(program: string, args: string[]) {
    try {
      return await execute(program, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60 * 60_000 });
    } catch (error) {
      const detail = error as { stderr?: string; message?: string };
      throw new Error(`E2B 本地快照操作失败：${(detail.stderr || detail.message || '命令失败').slice(0, 1200)}`);
    }
  }

  private mount(source: string, target: string, readonly = true) {
    // Docker's --mount parser treats commas as separators even without a shell.
    if (source.includes(',') || source.includes('\n')) throw new Error('快照路径不能包含逗号或换行');
    return ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`];
  }

  private async docker(args: string[], mounts: string[] = [], entrypoint = 'sh') {
    return this.command('docker', ['run', '--rm', '--network', 'none', '--read-only',
      '--security-opt', 'no-new-privileges', ...mounts, '--entrypoint', entrypoint, this.image, ...args]);
  }

  private async snapshot(sandboxId: string): Promise<Snapshot> {
    if (!/^[a-z0-9]{15,64}$/.test(sandboxId)) throw new Error('沙箱 ID 无效');
    // Strict sandbox ID validation makes this literal safe; no shell interpolation.
    const sql = `SELECT json_build_object(
      'sandboxId',s.sandbox_id,'rootBuildId',eb.id,'teamId',s.team_id,
      'templateId',s.env_id,'kernelVersion',eb.kernel_version,
      'firecrackerVersion',eb.firecracker_version,
      'filesystemOnly',COALESCE((s.config->>'filesystemOnly')::boolean,false))
      FROM public.snapshots s JOIN public.active_envs e ON e.id=s.env_id
      JOIN LATERAL (SELECT a.build_id FROM public.env_build_assignments a
        JOIN public.env_builds b ON b.id=a.build_id AND b.status_group='ready'
        WHERE a.env_id=s.env_id AND a.tag='default' ORDER BY a.created_at DESC LIMIT 1) latest ON true
      JOIN public.env_builds eb ON eb.id=latest.build_id WHERE s.sandbox_id='${sandboxId}';`;
    const { stdout } = await this.command('docker', ['compose', '-f', join(this.directory, 'compose.yaml'),
      'exec', '-T', 'postgres', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-At',
      '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    if (!stdout.trim()) throw new Error(`沙箱 ${sandboxId} 没有可归档的暂停快照`);
    const value = JSON.parse(stdout) as Snapshot;
    if (value.sandboxId !== sandboxId || !UUID.test(value.rootBuildId) || !UUID.test(value.teamId)) {
      throw new Error('E2B 快照元数据无效');
    }
    return value;
  }

  private async dependencies(snapshot: Snapshot) {
    const dependencies = new Set([snapshot.rootBuildId]);
    for (const artifact of snapshot.filesystemOnly ? ['rootfs'] : ['rootfs', 'memfile']) {
      const { stdout, stderr } = await this.docker(['-build', snapshot.rootBuildId,
        '-storage', '/storage', `-${artifact}`, '-json', '-recursive'], [
        ...this.mount(join(this.directory, 'templates'), '/storage/templates'),
        ...this.mount(this.inspectBinary, '/inspect'),
      ], '/inspect');
      // inspect-build is diagnostic and otherwise silently skips missing ancestors.
      if (/warning:/i.test(stderr)) throw new Error(`快照依赖不完整：${stderr.slice(0, 1000)}`);
      const reports = JSON.parse(stdout) as Inspection[];
      if (!Array.isArray(reports) || !reports.length) throw new Error('快照依赖图为空');
      for (const report of reports) {
        for (const id of [report.image.build_id, report.image.base_build_id,
          ...report.mappings.by_build.map((mapping) => mapping.build_id)]) {
          if (!UUID.test(id)) throw new Error('快照依赖 ID 无效');
          if (id !== ZERO_UUID) dependencies.add(id);
        }
      }
    }
    if (dependencies.size > 2000) throw new Error('快照依赖层数超过归档限制');
    return [...dependencies].sort();
  }

  private async verifyArchive(work: string): Promise<Manifest> {
    const mounts = this.mount(work, '/work');
    const names = (await this.docker(['-c', 'tar -tzf /work/archive.tar.gz'], mounts)).stdout.trim().split('\n');
    const verbose = (await this.docker(['-c', 'tar -tvzf /work/archive.tar.gz'], mounts)).stdout.trim().split('\n');
    if (names.length !== verbose.length || new Set(names).size !== names.length) throw new Error('归档条目重复或无效');
    const included = new Set<string>();
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      // BusyBox displays hardlinks with '-' too; both link kinds add a target suffix.
      if (!verbose[i].endsWith(` ${name}`)) throw new Error('归档不能包含链接或特殊条目');
      if (name === 'manifest.json' && verbose[i].startsWith('-')) continue;
      if (!name.startsWith('templates/')) throw new Error('归档包含非法目录');
      const [id, file, extra] = name.slice('templates/'.length).split('/');
      if (!UUID.test(id) || extra !== undefined || (file && !ARTIFACT.test(file))) throw new Error('归档包含非法路径');
      if ((file && !verbose[i].startsWith('-')) || (!file && !verbose[i].startsWith('d'))) {
        throw new Error('归档只允许普通文件和目录，不能包含链接');
      }
      included.add(id);
    }
    if (!names.includes('manifest.json')) throw new Error('归档缺少 manifest');
    const { stdout } = await this.docker(['-c', 'tar -xOzf /work/archive.tar.gz manifest.json'], mounts);
    const manifest = JSON.parse(stdout) as Manifest;
    if (manifest.version !== 1 || !UUID.test(manifest.rootBuildId)
      || typeof manifest.filesystemOnly !== 'boolean'
      || !Array.isArray(manifest.dependencies) || !manifest.dependencies.length
      || manifest.dependencies.some((id) => !UUID.test(id))
      || new Set(manifest.dependencies).size !== manifest.dependencies.length
      || !manifest.dependencies.includes(manifest.rootBuildId)
      || included.size !== manifest.dependencies.length
      || manifest.dependencies.some((id) => !included.has(id))) throw new Error('归档 manifest 无效');
    for (const id of manifest.dependencies) {
      if (!names.includes(`templates/${id}/rootfs.ext4.header`)) throw new Error(`归档缺少磁盘 header：${id}`);
    }
    for (const file of manifest.filesystemOnly ? ['metadata.json'] : ['metadata.json', 'memfile.header', 'snapfile']) {
      if (!names.includes(`templates/${manifest.rootBuildId}/${file}`)) throw new Error(`归档缺少 ${file}`);
    }
    return manifest;
  }

  private async validateData(snapshot: Snapshot, work: string) {
    await mkdir(join(work, 'cache'));
    for (const artifact of snapshot.filesystemOnly ? ['rootfs'] : ['rootfs', 'memfile']) {
      const { stderr } = await this.docker(['-build', snapshot.rootBuildId, '-storage', '/storage',
        `-${artifact}`, '-validate', '-recursive'], [
        ...this.mount(join(this.directory, 'templates'), '/storage/templates'),
        ...this.mount(this.inspectBinary, '/inspect'), ...this.mount(join(work, 'cache'), '/tmp', false),
      ], '/inspect');
      if (stderr.trim()) throw new Error(`快照数据校验失败：${stderr.slice(0, 1000)}`);
    }
  }

  async archive(sandboxId: string): Promise<StoredArchive> {
    const snapshot = await this.snapshot(sandboxId);
    const dependencies = await this.dependencies(snapshot);
    const work = await mkdtemp(join(tmpdir(), 'swarm-snapshot-'));
    try {
      const manifest: Manifest = { version: 1, ...snapshot, dependencies, archivedAt: new Date().toISOString() };
      await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      await this.validateData(snapshot, work);
      await this.docker(['-c', `set -eu
        tar -czf /work/archive.tar.gz -C /work manifest.json "$@"
        chmod 644 /work/archive.tar.gz`, 'archive', ...dependencies.map((id) => `templates/${id}`)], [
        ...this.mount(work, '/work', false), ...this.mount(join(this.directory, 'templates'), '/work/templates'),
      ]);
      await this.verifyArchive(work);
      if ((await this.snapshot(sandboxId)).rootBuildId !== snapshot.rootBuildId) throw new Error('归档期间快照已变化，请重试');
      return await this.storage.put(join(work, 'archive.tar.gz'));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async restore(sandboxId: string, ref: StoredArchive): Promise<void> {
    const snapshot = await this.snapshot(sandboxId);
    const work = await mkdtemp(join(tmpdir(), 'swarm-snapshot-'));
    try {
      await this.storage.get(ref, join(work, 'archive.tar.gz'));
      const manifest = await this.verifyArchive(work);
      if (manifest.sandboxId !== sandboxId || manifest.rootBuildId !== snapshot.rootBuildId
        || manifest.teamId !== snapshot.teamId || manifest.templateId !== snapshot.templateId
        || manifest.filesystemOnly !== snapshot.filesystemOnly) {
        throw new Error('归档与当前沙箱快照不匹配，已停止恢复');
      }
      await mkdir(join(work, 'cache'));
      // Shared dependencies may already exist. Compare first; never replace one.
      // flock also serializes restores belonging to different projects.
      await this.docker(['-c', `set -eu
        exec 9>/templates/.swarm-archive.lock
        flock -x 9
        stage=$(mktemp -d /templates/.swarm-restore.XXXXXXXX)
        trap 'rm -rf "$stage"' EXIT
        tar -xzf /work/archive.tar.gz -C "$stage"
        /inspect -build '${manifest.rootBuildId}' -storage "$stage" -rootfs -validate -recursive 2>/tmp/inspect-error
        [ ! -s /tmp/inspect-error ] || { cat /tmp/inspect-error >&2; exit 1; }
        ${manifest.filesystemOnly ? '' : `/inspect -build '${manifest.rootBuildId}' -storage "$stage" -memfile -validate -recursive 2>/tmp/inspect-error
        [ ! -s /tmp/inspect-error ] || { cat /tmp/inspect-error >&2; exit 1; }`}
        for id do
          if [ -e "/templates/$id" ] || [ -L "/templates/$id" ]; then
            [ ! -L "/templates/$id" ] && [ -d "/templates/$id" ] || exit 1
            diff -qr "/templates/$id" "$stage/templates/$id" >/dev/null || {
              echo "现有快照层不完整或内容不同，拒绝覆盖：$id" >&2; exit 1;
            }
          fi
        done
        for id do
          if [ ! -e "/templates/$id" ]; then mv -T "$stage/templates/$id" "/templates/$id"; fi
        done`, 'restore', ...manifest.dependencies], [
        ...this.mount(join(this.directory, 'templates'), '/templates', false), ...this.mount(work, '/work'),
        ...this.mount(this.inspectBinary, '/inspect'), ...this.mount(join(work, 'cache'), '/tmp', false),
      ]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
