import { randomUUID } from 'node:crypto';
import { CellboxClient, CellboxError, type CellboxImportedImage } from '../../packages/sandbox/src/providers/cellbox/client.js';
import type { ManagedImage, AddImageRepositoryInput, RegistryAuth, SyncImageVersionInput, ProjectImageSelection, ImageVersionUsage } from '../../protocol/image-types.js';
import type { Project } from '../../protocol/types.js';
import type { ImageCatalogStore, ImageRecord, ImageVersionRecord } from './store.js';
import { prepareImageRequest } from './build-command.js';
import { HttpError } from '../../util/errors.js';
import { DockerRegistryClient, normalizeRepository, registryImageReference, type ImageRegistry } from './registry.js';

const publicImage = (record: ImageRecord): ManagedImage => ({ ...record,
  versions: record.versions.filter(version => !version.deletedAt).map(({ request: _request, requiresRegistryAuth, ...version }) => ({ ...version, registryAuthRequired: requiresRegistryAuth })) });
const usageLabels: Record<string, string> = {
  'boxes-reference-image': 'Cellbox 中仍有环境或 Checkpoint 引用此镜像',
  'profiles-reference-image': '系统运行配置仍引用此镜像',
  'archives-reference-image': 'Cellbox 中仍有依赖原镜像的备份',
  'image-operation-running': 'Cellbox 正在构建或清理镜像',
  'manifest-not-deletable': '此镜像不属于平台可清理的成品仓库',
  'deletion-pending': '此镜像正在清理或上次清理尚未确认',
};

export class ImageCatalog {
  private records = new Map<string, ImageRecord>();
  private queue: Promise<unknown> = Promise.resolve();
  private reservations = new Map<string, number>();
  constructor(private store: ImageCatalogStore, private client: CellboxClient, private profileId: string,
    private registry: ImageRegistry = new DockerRegistryClient(), private projects: () => Project[] = () => []) {}
  async init() { for (const image of await this.store.listImages()) this.records.set(image.id, image); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => {}).then(work);
    this.queue = task;
    return task;
  }
  private async save(image: ImageRecord) {
    await this.store.saveImage(image);
    this.records.set(image.id, image);
  }
  private async refresh() {
    for (const stored of this.records.values()) {
      const record = structuredClone(stored);
      let changed = false;
      for (const version of record.versions) {
        if (version.deletedAt) continue;
        if (version.cleanup) {
          if (version.cleanup.operationId && version.cleanup.status !== 'failed') {
            try {
              const operation = await this.client.getOperation(version.cleanup.operationId);
              if (operation.status === 'succeeded') { version.deletedAt = new Date().toISOString(); delete version.cleanup; }
              else if (operation.status === 'failed') { version.cleanup.status = 'failed'; version.cleanup.error = operation.error?.message ?? 'Cellbox 镜像清理失败'; }
              changed = true;
            } catch { if (version.cleanup) version.cleanup.error = '清理结果暂时无法确认，请刷新或重试'; changed = true; }
          }
          continue;
        }
        if (version.status === 'submitting') {
          version.status = 'unknown'; version.error = '提交结果待确认，请用原请求重试确认'; changed = true;
        }
        if (!version.operationId || !['queued', 'running', 'unknown'].includes(version.status)) continue;
        let operation;
        try { operation = await this.client.getOperation(version.operationId); }
        catch (error) {
          if (!(error instanceof CellboxError)) throw error;
          version.error = '暂时无法查询构建结果，请刷新重试';
          if (error.code === 'NOT_FOUND') version.status = 'unknown';
          changed = true; continue;
        }
        changed = true;
        version.status = operation.status;
        delete version.error;
        if (operation.status === 'failed') version.error = operation.error?.message ?? '镜像构建失败';
        if (operation.status === 'succeeded') {
          const id = operation.result?.importedImageId;
          if (!id) { version.status = 'failed'; version.error = 'Cellbox 未返回导入镜像 ID'; continue; }
          const image = await this.client.getImage(id);
          version.importedImageId = image.id; version.image = image.image;
          version.resolvedSource = image.resolvedSource; version.warnings = image.warnings;
          delete version.error;
        }
      }
      if (!record.defaultVersionId) {
        const ready = record.versions.find(version => !version.deletedAt && !version.cleanup && version.status === 'succeeded' && version.projectReady !== false);
        if (ready) { record.defaultVersionId = ready.id; changed = true; }
      }
      if (changed) await this.save(record);
    }
  }
  private external(images: CellboxImportedImage[]): ManagedImage[] {
    const known = new Set([...this.records.values()].flatMap(image => image.versions.map(version => version.importedImageId)));
    const groups = new Map<string, ManagedImage>();
    for (const image of images) {
      if (known.has(image.id) || image.deleting) continue;
      const source = image.source;
      const repository = source.replace(/@.*$/, '').replace(/:[^/]+$/, '');
      const id = `cellbox:${repository}`;
      const group = groups.get(id) ?? { id, name: repository, repository, category: '已导入', origin: 'cellbox' as const, versions: [] };
      group.versions.push({ id: image.id, version: source.includes('@') ? source.split('@')[1] : source.slice(repository.length + 1) || 'latest',
        source, status: 'succeeded', importedImageId: image.id, image: image.image, resolvedSource: image.resolvedSource,
        projectReady: image.command[0] === '/usr/local/bin/node' && image.command[1] === '/opt/product/cocell/launcher.mjs',
        warnings: image.warnings, createdAt: image.createdAt });
      groups.set(id, group);
    }
    return [...groups.values()];
  }
  private async readImages(): Promise<ManagedImage[]> {
    await this.refresh();
    const [images, profiles] = await Promise.all([this.client.listImages(), this.client.listProfiles()]);
    const profile = profiles.find(profile => profile.id === this.profileId);
    const builtin: ManagedImage[] = profile ? [{ id: 'default', name: '系统默认镜像', category: '系统', origin: 'profile',
      versions: [{ id: 'default', version: '当前配置', source: profile.image, image: profile.image, status: 'succeeded', createdAt: '' }] }] : [];
    return [...builtin, ...[...this.records.values()].map(publicImage), ...this.external(images)];
  }
  list(): Promise<ManagedImage[]> {
    return this.exclusive(() => this.readImages());
  }
  addRepository(input: AddImageRepositoryInput): Promise<ManagedImage> {
    return this.exclusive(async () => {
      const repository = normalizeRepository(input.repository);
      if (!input.name.trim() || !input.category.trim()) throw new HttpError(400, '请输入仓库名称和类型');
      if ([...this.records.values()].some(image => image.repository === repository)) throw new HttpError(409, '该镜像仓库已添加，请进入仓库同步版本');
      if ([...this.records.values()].some(image => image.name === input.name.trim() && image.category === input.category.trim())) throw new HttpError(409, '同类型仓库名称已存在');
      // Validate the complete build command before saving the repository.
      await prepareImageRequest(registryImageReference(repository, 'latest'), input.buildCommand);
      const record: ImageRecord = { id: randomUUID(), name: input.name.trim(), category: input.category.trim(), repository,
        origin: 'managed', versions: [], registryAuthRequired: Boolean(input.registryAuthRequired),
        ...(input.buildCommand ? { buildCommand: input.buildCommand } : {}) };
      await this.save(record);
      return publicImage(record);
    });
  }
  private repository(id: string, auth?: RegistryAuth) {
    const image = this.records.get(id);
    if (!image?.repository) throw new HttpError(404, '镜像仓库不存在，请先添加仓库');
    if (image.registryAuthRequired && !auth) throw new HttpError(400, '请提供私有仓库用户名和 Token，平台不保存这些凭证');
    return image;
  }
  async tags(imageId: string, auth?: RegistryAuth, last?: string) {
    const image = this.repository(imageId, auth);
    return this.registry.listTags(image.repository!, auth, { last, limit: 100 });
  }
  sync(imageId: string, input: SyncImageVersionInput): Promise<ManagedImage> {
    return this.exclusive(async () => {
      await this.refresh();
      const stored = this.repository(imageId, input.registryAuth);
      // Unknown acceptance must be confirmed with its original request before
      // another import can claim the single image builder.
      const pending = [...this.records.values()].flatMap(image => image.versions)
        .find(version => ['queued', 'running', 'unknown', 'submitting'].includes(version.status));
      if (pending) {
        if (stored.versions.includes(pending) && pending.version === input.tag && pending.status !== 'unknown') return publicImage(stored);
        throw new HttpError(409, '已有版本正在同步或结果待确认，请等待完成或确认结果');
      }
      const digest = await this.registry.resolveTag(stored.repository!, input.tag, input.registryAuth);
      const existing = stored.versions.find(version => !version.deletedAt && !version.cleanup && version.version === input.tag);
      if (existing?.upstreamDigest === digest && existing.status === 'succeeded') return publicImage(stored);
      const source = registryImageReference(stored.repository!, input.tag);
      const request = await prepareImageRequest(registryImageReference(stored.repository!, digest), stored.buildCommand);
      const record = structuredClone(stored);
      const version: ImageVersionRecord = { id: randomUUID(), version: input.tag, source, upstreamDigest: digest,
        status: 'submitting', createdAt: new Date().toISOString(), request, projectReady: true, requiresRegistryAuth: Boolean(input.registryAuth),
        ...(stored.buildCommand ? { buildCommand: stored.buildCommand } : {}), runCommand: request.runCommand };
      record.versions.unshift(version);
      // Save the exact request and key before submitting any external mutation.
      await this.save(record);
      await this.submit(record, version, input.registryAuth);
      return publicImage(this.records.get(record.id)!);
    });
  }
  retry(imageId: string, versionId: string, auth?: RegistryAuth) {
    return this.exclusive(async () => {
      const stored = this.records.get(imageId);
      if (!stored) throw new HttpError(404, '镜像不存在');
      const record = structuredClone(stored);
      const version = record.versions.find(version => version.id === versionId);
      if (!version) throw new HttpError(404, '版本不存在');
      if (!['unknown', 'submitting'].includes(version.status)) throw new HttpError(409, '只有结果未确认的导入请求可以原样重试');
      if (version.requiresRegistryAuth && !auth) throw new HttpError(400, '请重新提供私有仓库凭证，平台不保存这些凭证');
      if (!version.requiresRegistryAuth && auth) throw new HttpError(400, '原请求未携带仓库凭证，请保持请求一致');
      await this.submit(record, version, auth, true);
      return publicImage(this.records.get(imageId)!);
    });
  }
  private async submit(record: ImageRecord, version: ImageVersionRecord, registryAuth?: RegistryAuth, retry = false) {
    try {
      const operation = await this.client.importImage({ ...version.request, ...(registryAuth ? { registryAuth } : {}) }, `cocell-image-${version.id}`);
      version.operationId = operation.id;
      // Completion is reconciled through GET so the imported image metadata is fetched too.
      version.status = operation.status === 'succeeded' ? 'running' : operation.status;
      if (operation.status === 'failed') version.error = operation.error?.message ?? '导入失败';
      else delete version.error;
    } catch (error) {
      const uncertain = retry || !(error instanceof CellboxError) || error.code === 'UNKNOWN_OUTCOME';
      version.status = uncertain ? 'unknown' : 'failed';
      version.error = uncertain ? '提交结果待确认，请用原请求重试确认' : (error as Error).message;
      if (registryAuth?.password) version.error = version.error.replaceAll(registryAuth.password, '[redacted]');
    }
    await this.save(record);
  }
  async resolve(imageId: string, versionId: string): Promise<ProjectImageSelection | undefined> {
    return this.exclusive(() => this.resolveAvailable(imageId, versionId));
  }
  private async resolveAvailable(imageId: string, versionId: string): Promise<ProjectImageSelection | undefined> {
    const image = (await this.readImages()).find(image => image.id === imageId);
    const version = image?.versions.find(version => version.id === versionId);
    if (!image || !version) throw new HttpError(404, '镜像或版本不存在');
    if (version.cleanup) throw new HttpError(409, '镜像版本正在清理或清理结果待确认');
    if (version.status !== 'succeeded') throw new HttpError(409, '请选择已导入成功的镜像版本');
    if (version.projectReady === false) throw new HttpError(409, '此版本尚未配置 CoCell 启动器，请添加源仓库并同步对应版本');
    if (image.origin === 'profile') return undefined;
    if (!version.importedImageId || !version.image) throw new HttpError(409, '镜像版本尚未就绪');
    const remote = await this.client.getImage(version.importedImageId);
    if (remote.deleting) throw new HttpError(409, 'Cellbox 正在清理此镜像版本');
    if (remote.image !== version.image) throw new HttpError(409, '镜像身份与版本记录不一致');
    return { imageId: image.id, imageName: image.name, category: image.category, versionId: version.id,
      version: version.version, importedImageId: remote.id, image: remote.image };
  }

  /** Reserve while a project or staged restore becomes a durable reference. */
  acquireSelection(imageId: string, versionId: string) {
    return this.exclusive(async () => this.reserve(await this.resolveAvailable(imageId, versionId)));
  }
  private reserve(selection?: ProjectImageSelection) {
    const key = selection?.image;
    if (key) this.reservations.set(key, (this.reservations.get(key) ?? 0) + 1);
    let released = false;
    return { selection, release: () => {
      if (released || !key) return;
      released = true;
      const count = (this.reservations.get(key) ?? 1) - 1;
      if (count) this.reservations.set(key, count); else this.reservations.delete(key);
    } };
  }
  acquireRestoreSelection(project: Project, versionId?: string) {
    return this.exclusive(async () => {
      if (!project.imageSelection) {
        if (versionId) throw new HttpError(400, '系统镜像项目不能选择其他仓库版本');
        return this.reserve();
      }
      const image = (await this.readImages()).find(image => image.id === project.imageSelection!.imageId);
      if (!image) throw new HttpError(409, '项目镜像仓库已不可用，请先同步可用版本');
      const selected = versionId ?? image.defaultVersionId ?? image.versions
        .filter(value => value.status === 'succeeded' && !value.cleanup && value.projectReady !== false)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
      if (!selected) throw new HttpError(409, '仓库没有可恢复的镜像版本，请先同步版本');
      return this.reserve(await this.resolveAvailable(image.id, selected));
    });
  }
  setDefault(imageId: string, versionId: string) {
    return this.exclusive(async () => {
      await this.resolveAvailable(imageId, versionId);
      const stored = this.records.get(imageId);
      if (!stored) throw new HttpError(400, '只有平台管理的仓库可以设置默认版本');
      const record = structuredClone(stored); record.defaultVersionId = versionId;
      await this.save(record); return publicImage(record);
    });
  }
  private cleanupVersion(imageId: string, versionId: string) {
    const record = this.records.get(imageId);
    const version = record?.versions.find(value => value.id === versionId && !value.deletedAt);
    if (!record || !version) throw new HttpError(404, '镜像或版本不存在');
    return { record, version };
  }
  private blockers(record: ImageRecord, version: ImageVersionRecord) {
    const blockers: string[] = [];
    if (record.defaultVersionId === version.id) blockers.push('仓库默认版本，请先指定其他默认版本');
    if (['submitting', 'queued', 'running', 'unknown'].includes(version.status)) blockers.push('版本仍在同步或导入结果待确认');
    if (version.image && this.reservations.has(version.image)) blockers.push('版本正在被创建或恢复操作使用');
    for (const project of this.projects()) {
      const selected = project.imageSelection;
      if (project.status !== 'archived' && selected && (selected.versionId === version.id || selected.image === version.image)) blockers.push(`项目「${project.name}」仍固定此版本`);
      if ([project.sandbox, ...(project.pendingSandboxCleanup ?? [])].some(box => box && version.image && box.image?.id === version.image)) blockers.push(`项目「${project.name}」仍有 Sandbox 或待清理环境使用此镜像`);
      if (project.remoteArchives?.some(ref => ref.storageType !== 'oss' && !ref.portable && ref.imageId === version.image)) blockers.push(`项目「${project.name}」有依赖原镜像的备份`);
    }
    return [...new Set(blockers)];
  }
  usage(imageId: string, versionId: string): Promise<ImageVersionUsage> {
    return this.exclusive(async () => {
      await this.refresh();
      const { record, version } = this.cleanupVersion(imageId, versionId);
      const blockers = this.blockers(record, version);
      const remote = version.importedImageId ? await this.client.imageUsage(version.importedImageId) : undefined;
      if (remote) blockers.push(...remote.blockers.map(reason => usageLabels[reason] ?? 'Cellbox 检测到此镜像仍不可清理'));
      return { deletable: blockers.length === 0 && (!remote || remote.deletable), blockers, manifestShared: remote?.manifestShared ?? false };
    });
  }
  removeVersion(imageId: string, versionId: string): Promise<ManagedImage> {
    return this.exclusive(async () => {
      await this.refresh();
      const { record: stored, version: original } = this.cleanupVersion(imageId, versionId);
      const blockers = this.blockers(stored, original);
      if (blockers.length) throw new HttpError(409, blockers.join('；'));
      const record = structuredClone(stored), version = record.versions.find(value => value.id === versionId)!;
      if (!version.importedImageId) {
        version.deletedAt = new Date().toISOString();
        await this.save(record); return publicImage(record);
      }
      const previousCleanup = version.cleanup;
      const freshAttempt = !previousCleanup || previousCleanup.status === 'failed';
      if (!version.cleanup || version.cleanup.status === 'failed') version.cleanup = { id: randomUUID(), status: 'unknown' };
      await this.save(record);
      try {
        const operation = await this.client.deleteImage(version.importedImageId, `cocell-image-delete-${version.cleanup.id}`);
        version.cleanup.operationId = operation.id;
        version.cleanup.status = operation.status === 'failed' ? 'failed' : 'pending';
        version.cleanup.error = operation.error?.message;
      } catch (error) {
        // A response can be lost after manifest deletion. Keep the version
        // unavailable and retry the original key until its outcome is known.
        if (error instanceof CellboxError && error.code === 'NOT_FOUND') {
          version.deletedAt = new Date().toISOString(); delete version.cleanup;
        } else if (freshAttempt && error instanceof CellboxError && error.status && error.status >= 400 && error.status < 500
          && ['CONFLICT', 'BUSY', 'INVALID_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'UNSUPPORTED_CAPABILITY'].includes(error.code)) {
          // These responses reject a fresh request before an operation starts.
          // A rejected retry must retain the previous failed operation: Cellbox
          // may still fence this image after a failed registry deletion.
          version.cleanup = previousCleanup;
          await this.save(record);
          throw new HttpError(error.code === 'CONFLICT' || error.code === 'BUSY' ? 409 : 502,
            error.code === 'CONFLICT' || error.code === 'BUSY' ? 'Cellbox 检测到镜像仍被引用或其他镜像操作正在执行，请刷新后重试' : 'Cellbox 无法执行镜像清理，请检查接口和 Registry 配置');
        } else {
          version.cleanup.error = error instanceof CellboxError ? error.message : '清理结果待确认，请重试';
          version.cleanup.status = 'unknown';
        }
      }
      await this.save(record);
      await this.refresh();
      return publicImage(this.records.get(imageId)!);
    });
  }
}
