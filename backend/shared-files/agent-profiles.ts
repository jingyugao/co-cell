import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MemoryCoordinator, type SharedCoordinator } from '../infra/storage/coordination.js';
import type { AgentProfile, RemoteSkill } from '../../protocol/agent-profile-types.js';
import { SharedFiles } from './service.js';
import { fetchGithubSkill, maxBytes, maxFiles, skillName, type AssetFile } from './github-skill.js';
import { HttpError } from '../../util/errors.js';

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const exists = async (path: string) =>
  lstat(path).then(
    () => true,
    (e) => {
      if (missing(e)) return false;
      throw e;
    },
  );
const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const validId = /^(?:default|[a-f0-9-]{36})$/;
export async function assetFiles(directory: string, normalizeModes = false) {
  const files: AssetFile[] = [];
  let bytes = 0;
  async function visit(relative: string) {
    if (normalizeModes) await chmod(join(directory, relative), 0o755);
    for (const e of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(relative, e.name),
        file = join(directory, path);
      if (e.isDirectory()) await visit(path);
      else {
        if (!e.isFile()) throw new HttpError(422, 'Agent 配置只支持普通文件');
        const stat = await lstat(file);
        bytes += stat.size;
        if (bytes > maxBytes || files.length >= maxFiles) throw new HttpError(413, 'Agent 配置最多 512 个文件、16 MiB');
        if (normalizeModes) await chmod(file, stat.mode & 0o111 ? 0o755 : 0o644);
        files.push({ path, bytes: await readFile(file), executable: Boolean(stat.mode & 0o111) });
      }
    }
  }
  await visit('');
  return files;
}
type Mutation = (assets: string, profile: AgentProfile) => Promise<void>;
export class AgentProfiles {
  readonly root: string;
  constructor(
    private shared: string,
    private coordinator: SharedCoordinator = new MemoryCoordinator(),
    private publish?: (revision: string, files: AssetFile[]) => Promise<void>,
  ) {
    this.root = join(shared, 'agents');
  }
  lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    return this.coordinator.run('agents:' + key, action);
  }
  assets(revision: string) {
    if (!/^[0-9a-f]{64}$/.test(revision)) throw new Error('Invalid Agent revision');
    return join(this.root, 'versions', revision, 'assets');
  }
  private record(id: string) {
    if (!validId.test(id)) throw new HttpError(404, 'Agent 不存在');
    return join(this.root, 'profiles', id + '.json');
  }
  async get(id: string): Promise<AgentProfile> {
    try {
      return JSON.parse(await readFile(this.record(id), 'utf8'));
    } catch (e) {
      if (missing(e)) throw new HttpError(404, 'Agent 不存在');
      throw e;
    }
  }
  async list(): Promise<AgentProfile[]> {
    const names = await readdir(join(this.root, 'profiles'));
    return Promise.all(
      names
        .filter((n) => n.endsWith('.json') && validId.test(n.slice(0, -5)))
        .sort()
        .map((n) => this.get(n.slice(0, -5))),
    );
  }
  async init() {
    await mkdir(join(this.root, 'profiles'), { recursive: true });
    await mkdir(join(this.root, 'versions'), { recursive: true });
    await this.lock('default', async () => {
      if (await exists(this.record('default'))) return;
      const revision = await readFile(join(this.shared, 'harness/current'), 'utf8').catch((e) => {
        if (missing(e)) return '';
        throw e;
      });
      const bundled = /^[0-9a-f]{64}$/.test(revision.trim())
        ? join(this.shared, 'harness/versions', revision.trim(), 'assets')
        : undefined;
      await this.save(
        { id: 'default', name: '默认 Agent', description: '', revision: '', remoteSkills: [] },
        async (assets) => {
          for (const name of ['AGENTS.md', 'docs', 'skills']) {
            const source =
              bundled && (await exists(join(bundled, name))) ? join(bundled, name) : join(this.shared, name);
            if (await exists(source)) await cp(source, join(assets, name), { recursive: true });
          }
        },
      );
    });
  }
  create(name: string, description: string, source?: string) {
    return this.lock('create', async () => {
      const previous = source ? await this.get(source) : undefined;
      return this.save(
        {
          id: randomUUID(),
          name,
          description,
          revision: previous?.revision ?? '',
          remoteSkills: previous?.remoteSkills ?? [],
        },
        async () => {},
      );
    });
  }
  files(profile: AgentProfile) {
    return new SharedFiles(this.assets(profile.revision), true, undefined, true);
  }
  edit(id: string, action: Mutation) {
    return this.lock(id, async () => this.save(await this.get(id), action));
  }
  private async save(profile: AgentProfile, action: Mutation) {
    const temp = await mkdtemp(join(this.root, '.edit-')),
      assets = join(temp, 'assets');
    try {
      await mkdir(assets, { mode: 0o755 });
      if (profile.revision) await cp(this.assets(profile.revision), assets, { recursive: true });
      await action(assets, profile);
      for (const name of ['docs', 'skills']) await mkdir(join(assets, name), { recursive: true });
      if (!profile.revision && !(await exists(join(assets, 'AGENTS.md'))))
        await writeFile(join(assets, 'AGENTS.md'), '');
      const files = await assetFiles(assets, true);
      for (const skill of await readdir(join(assets, 'skills'), { withFileTypes: true })) {
        if (
          !skill.isDirectory() ||
          !skillName.test(skill.name) ||
          !files.some((f) => f.path === 'skills/' + skill.name + '/SKILL.md')
        )
          throw new HttpError(422, '每个 skill 需要 skills/<名称>/SKILL.md');
      }
      const revision = digest(JSON.stringify(files.map((f) => [f.path, f.executable, digest(f.bytes)])));
      const dest = dirname(this.assets(revision));
      await this.publish?.(revision, files);
      if (!(await exists(dest))) {
        await chmod(temp, 0o755);
        try {
          await rename(temp, dest);
        } catch (e) {
          if (!(await exists(dest))) throw e;
        }
      }
      profile.revision = revision;
      const record = this.record(profile.id),
        next = record + '.' + randomUUID();
      try {
        await writeFile(next, JSON.stringify(profile), { flag: 'wx', mode: 0o644 });
        await rename(next, record);
      } finally {
        await rm(next, { force: true });
      }
      return profile;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async importSkill(id: string, source: Omit<RemoteSkill, 'commit'>, expected: string) {
    if ((await this.get(id)).revision !== expected) throw new HttpError(409, 'Agent 已修改，请刷新后重试');
    const imported = await fetchGithubSkill(source);
    return this.edit(id, async (assets, profile) => {
      if (profile.revision !== expected) throw new HttpError(409, 'Agent 已修改，请刷新后重试');
      const dir = join(assets, 'skills', source.name);
      const previous = profile.remoteSkills.find((s) => s.name === source.name);
      if (!previous && (await exists(dir))) throw new HttpError(409, '同名本地 skill 已存在');
      await rm(dir, { recursive: true, force: true });
      for (const f of imported.files) {
        const path = join(dir, f.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, f.bytes, { mode: f.executable ? 0o755 : 0o644 });
      }
      profile.remoteSkills = [...profile.remoteSkills.filter((s) => s.name !== source.name), imported.source];
    });
  }
}
