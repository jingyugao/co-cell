import { randomUUID } from 'node:crypto';
import { CellboxClient, CellboxError } from '../../packages/sandbox/src/providers/cellbox/client.js';
import type { ManagedImage, AddImageRepositoryInput, RegistryAuth, SyncImageVersionInput, ProjectImageSelection, ImageVersionUsage, DefaultImageSelection } from '../../protocol/image-types.js';
import type { Project } from '../../protocol/types.js';
import type { ImageCatalogStore, ImageRecord, ImageVersionRecord } from './store.js';
import { prepareImageRequest } from './build-command.js';
import { HttpError, redactCredentials } from '../../util/errors.js';
import { DockerRegistryClient, normalizeRepository, registryImageReference, type ImageRegistry } from './registry.js';

const publicImage = ({ deletedAt: _deletedAt, legacyImport: _legacyImport, ...record }: ImageRecord): ManagedImage => ({
  ...record,
  migrationRequired: record.migrationRequired || (!record.templateId && record.origin === 'managed' && !record.templateStatus) || undefined,
  versions: record.versions.map(({ request: _request, preparationKey: _preparationKey, requiresRegistryAuth, ...version }) => ({
    ...version,
    registryAuthRequired: requiresRegistryAuth ?? version.registryAuthRequired,
    migrationRequired: version.migrationRequired || (!version.revisionId && Boolean(version.importedImageId)) || undefined,
  })),
});

const statusOf = (operation: { status: string }): ImageVersionRecord['status'] => operation.status as ImageVersionRecord['status'];
const usageUnsupported = (): ImageVersionUsage => ({ deletable: false,
  blockers: ['Cellbox 不支持物理删除 revision；可将版本退休'], manifestShared: false });

/** CoCell stores product labels and the default selection; Cellbox owns templates and revisions. */
export class ImageCatalog {
  private records = new Map<string, ImageRecord>();
  constructor(private store: ImageCatalogStore, private client: CellboxClient, private profileId: string,
    private registry: ImageRegistry = new DockerRegistryClient(), private projects: () => Project[] | Promise<Project[]> = () => [],
    private options: { defaultTemplateId?: string; defaultRevisionId?: string } = {}) {}

  async init() { await this.loadRecords(); }
  private async loadRecords() {
    const records = await this.store.listImages();
    this.records = new Map(records.map(image => [image.id, image]));
  }
  private async save(image: ImageRecord) {
    await this.store.saveImage(image);
    this.records.set(image.id, image);
  }
  private async defaultSelection(): Promise<DefaultImageSelection | undefined> {
    const saved = await this.store.loadDefaultImage();
    if (saved?.templateId && saved.revisionId) return saved;
    if (this.options.defaultRevisionId) {
      const revision = await this.client.getTemplateRevision(this.options.defaultRevisionId);
      return { templateId: revision.templateId, revisionId: revision.id };
    }
    if (this.options.defaultTemplateId) {
      const template = await this.client.getTemplate(this.options.defaultTemplateId);
      if (template.stableRevisionId) return { templateId: template.id, revisionId: template.stableRevisionId };
    }
    return undefined;
  }
  private async refreshOperations() {
    await this.loadRecords();
    for (const stored of this.records.values()) {
      if (stored.deletedAt) continue;
      const record = structuredClone(stored);
      let changed = false;
      if (record.templateStatus === 'submitting') {
        record.templateStatus = 'unknown';
        record.error = '提交结果尚未确认，Cellbox template 创建结果未知；不会自动重提';
        changed = true;
      }
      for (const version of record.versions) {
        if (version.status === 'submitting' && !version.operationId) {
          version.status = 'unknown';
          version.error = '提交结果尚未确认，Cellbox build 提交结果未知；不会自动重提';
          changed = true;
          continue;
        }
        if (!version.operationId || !['queued', 'running', 'unknown'].includes(version.status)) continue;
        try {
          const operation = await this.client.getOperation(version.operationId);
          version.status = statusOf(operation);
          if (operation.status === 'failed') version.error = redactCredentials(operation.error?.message ?? 'Cellbox revision 构建失败');
          if (operation.status === 'succeeded') {
            const revisionId = operation.result?.revisionId;
            if (!revisionId) {
              version.status = 'failed';
              version.error = 'Cellbox 构建成功但未返回 revisionId';
            } else {
              const revision = await this.client.getTemplateRevision(revisionId);
              version.revisionId = revision.id;
              version.templateId = revision.templateId;
              version.image = revision.image;
              version.source = revision.resolvedBaseImage;
              version.status = 'succeeded';
              delete version.error;
            }
          }
          changed = true;
        } catch (error) {
          version.error = error instanceof Error ? redactCredentials(error.message) : '无法读取 Cellbox 构建状态';
          changed = true;
        }
      }
      if (changed) await this.save(record);
    }
  }
  private legacyRecords(): ManagedImage[] {
    return [...this.records.values()].filter(record => !record.deletedAt && !record.templateId && !record.templateStatus && record.origin === 'managed')
      .map(record => ({ ...publicImage(record), migrationRequired: true, versions: record.versions.map(version => ({
        ...version, migrationRequired: true, projectReady: false,
      })) }));
  }
  private async remoteCatalog(): Promise<ManagedImage[]> {
    const templates = await this.client.listTemplates();
    const selected = await this.defaultSelection();
    const templateItems: ManagedImage[] = await Promise.all(templates.map(async template => {
      const owner = [...this.records.values()].find(record => record.templateId === template.id && !record.deletedAt);
      const revisions = await this.client.listTemplateRevisions(template.id);
      const localVersions = owner?.versions ?? [];
      const versions: ImageVersionRecord[] = revisions.map(revision => {
        const local = localVersions.find(value => value.revisionId === revision.id);
        return { ...(local ?? {}), id: revision.id, templateId: template.id, revisionId: revision.id,
          version: revision.version, userVersion: revision.userVersion, source: revision.resolvedBaseImage, image: revision.image,
          status: 'succeeded', createdAt: revision.createdAt,
          deprecatedAt: revision.status === 'retired' ? local?.deprecatedAt ?? revision.updatedAt : undefined,
          projectReady: Boolean(owner) || selected?.revisionId === revision.id,
          buildCommand: revision.buildCommand, runCommand: revision.runCommand,
          isDefault: selected?.templateId === template.id && selected.revisionId === revision.id,
        };
      });
      for (const local of localVersions) if (!local.revisionId && local.status !== 'failed') versions.unshift(local);
      return {
        id: owner?.id ?? `cellbox:${template.id}`, templateId: template.id,
        name: owner?.name ?? template.name, category: owner?.category ?? 'Cellbox',
        repository: owner?.repository, buildCommand: owner?.buildCommand,
        registryAuthRequired: owner?.registryAuthRequired,
        defaultVersionId: template.stableRevisionId,
        origin: owner ? 'managed' as const : 'cellbox' as const,
        versions,
      };
    }));
    const remoteIds = new Set(templates.map(template => template.id));
    for (const record of this.records.values()) {
      if (record.templateId && !remoteIds.has(record.templateId) && !record.deletedAt) {
        templateItems.push({ ...publicImage(record), migrationRequired: true });
      }
      if (!record.templateId && record.templateStatus && !record.deletedAt) templateItems.push(publicImage(record));
    }
    return templateItems;
  }
  async list(): Promise<ManagedImage[]> {
    await this.refreshOperations();
    const [remote, selected] = await Promise.all([this.remoteCatalog(), this.defaultSelection()]);
    const legacy = this.legacyRecords();
    const all = [...remote, ...legacy];
    if (selected && !all.some(image => image.versions.some(version => version.id === selected.revisionId))) {
      try {
        const revision = await this.client.getTemplateRevision(selected.revisionId);
        const template = await this.client.getTemplate(selected.templateId);
        all.unshift({ id: `cellbox:${template.id}`, templateId: template.id, name: template.name, category: '系统', origin: 'profile',
          versions: [{ id: revision.id, templateId: template.id, revisionId: revision.id, version: revision.version,
            source: revision.resolvedBaseImage, image: revision.image, status: 'succeeded', createdAt: revision.createdAt, isDefault: true }] });
      } catch { /* Keep the configured selection visible as unresolved in its consumers. */ }
    }
    return all.map(image => ({ ...image, versions: image.versions.map(version => ({ ...version,
      isDefault: Boolean(selected && selected.templateId === version.templateId && selected.revisionId === version.revisionId),
    })) }));
  }
  async addRepository(input: AddImageRepositoryInput): Promise<ManagedImage> {
    await this.loadRecords();
    const repository = normalizeRepository(input.repository);
    if (!input.name.trim() || !input.category.trim()) throw new HttpError(400, '请输入仓库名称和类型');
    if ([...this.records.values()].some(image => !image.deletedAt && (image.templateId || image.templateStatus) && image.repository === repository)) throw new HttpError(409, '该镜像仓库已添加，请进入仓库同步版本');
    if ([...this.records.values()].some(image => !image.deletedAt && (image.templateId || image.templateStatus)
      && image.name === input.name.trim() && image.category === input.category.trim())) throw new HttpError(409, '同类型仓库名称已存在');
    await prepareImageRequest(registryImageReference(repository, 'latest'), input.buildCommand);
    const record: ImageRecord = { id: randomUUID(), name: input.name.trim(), category: input.category.trim(), repository,
      origin: 'managed', versions: [], templateStatus: 'submitting', registryAuthRequired: Boolean(input.registryAuthRequired),
      ...(input.buildCommand ? { buildCommand: input.buildCommand } : {}) } as ImageRecord;
    await this.save(record);
    try {
      const template = await this.client.createTemplate({ name: record.name, description: `CoCell image repository: ${repository}` });
      record.templateId = template.id;
      record.templateStatus = 'ready';
      delete record.error;
    } catch (error) {
      record.templateStatus = error instanceof CellboxError && error.code !== 'UNKNOWN_OUTCOME' ? 'failed' : 'unknown';
      record.error = error instanceof Error ? redactCredentials(error.message) : 'Cellbox template 创建结果未知';
    }
    await this.save(record);
    return publicImage(record);
  }
  private repository(id: string) {
    const image = this.records.get(id);
    if (!image?.repository || image.deletedAt || image.origin !== 'managed') throw new HttpError(404, '镜像仓库不存在，请先添加仓库');
    if (!image.templateId) throw new HttpError(409, '该仓库尚未关联 Cellbox template，状态待确认或需要迁移');
    return image;
  }
  async tags(imageId: string, auth?: RegistryAuth, last?: string) {
    await this.loadRecords();
    const image = this.repository(imageId);
    if (image.registryAuthRequired && !auth) throw new HttpError(400, '请提供私有仓库用户名和 Token；凭证仅用于查询');
    return this.registry.listTags(image.repository!, auth, { last, limit: 100 });
  }
  async sync(imageId: string, input: SyncImageVersionInput): Promise<ManagedImage> {
    await this.loadRecords();
    const stored = this.repository(imageId);
    if (input.registryAuth) throw new HttpError(422, 'UNSUPPORTED: Cellbox template build does not accept per-request registry credentials');
    if (stored.registryAuthRequired) throw new HttpError(422, 'UNSUPPORTED: 私有仓库构建凭据需配置在 Cellbox 部署侧；当前版本不支持请求级凭据');
    const digest = await this.registry.resolveTag(stored.repository!, input.tag);
    const prepared = await prepareImageRequest(registryImageReference(stored.repository!, digest), stored.buildCommand);
    const record = structuredClone(stored);
    const version: ImageVersionRecord = { id: randomUUID(), userVersion: input.tag, version: input.tag,
      templateId: stored.templateId, source: registryImageReference(stored.repository!, input.tag), upstreamDigest: digest,
      status: 'submitting', createdAt: new Date().toISOString(), projectReady: true, buildCommand: stored.buildCommand,
      runCommand: prepared.runCommand };
    record.versions.unshift(version);
    await this.save(record);
    try {
      const operation = await this.client.createTemplateRevision(stored.templateId!, {
        userVersion: input.tag, baseImage: prepared.url, profileId: this.profileId,
        buildCommand: prepared.buildCommand, runCommand: prepared.runCommand, platform: 'linux/amd64',
      });
      version.operationId = operation.id;
      version.status = operation.status === 'succeeded' ? 'running' : statusOf(operation);
      if (operation.status === 'failed') version.error = redactCredentials(operation.error?.message ?? 'Cellbox revision 构建失败');
      else delete version.error;
    } catch (error) {
      version.status = error instanceof CellboxError && error.code !== 'UNKNOWN_OUTCOME' ? 'failed' : 'unknown';
      version.error = error instanceof Error ? redactCredentials(error.message) : 'Cellbox 构建提交结果未知';
    }
    await this.save(record);
    return publicImage(record);
  }
  async retry(_imageId: string, _versionId: string, _auth?: RegistryAuth): Promise<ManagedImage> {
    throw new HttpError(410, '结果待确认的构建不会自动重放；请检查 Cellbox 状态，或明确提交一次新的构建');
  }
  async resolve(imageId: string, versionId: string): Promise<ProjectImageSelection | undefined> {
    const images = await this.list();
    const image = images.find(value => value.id === imageId);
    const version = image?.versions.find(value => value.id === versionId);
    if (!image || !version) throw new HttpError(404, '镜像或版本不存在');
    return this.resolveVersion(image, version);
  }
  private async resolveVersion(image: ManagedImage, version: ManagedImage['versions'][number]): Promise<ProjectImageSelection> {
    if (version.migrationRequired || !version.revisionId || !version.templateId)
      throw new HttpError(409, '此旧 importedImage 尚未迁移到 Cellbox revision，不能用于新项目');
    if (version.deprecatedAt) throw new HttpError(409, 'Cellbox revision 已退休，请选择生效中的版本');
    if (version.projectReady === false) throw new HttpError(409, '此 Cellbox revision 尚未配置 CoCell 启动器，不能用于 CoCell 项目');
    const remote = await this.client.getTemplateRevision(version.revisionId);
    if (remote.status !== 'active') throw new HttpError(409, 'Cellbox revision 已退休，请选择生效中的版本');
    return { imageId: image.id, imageName: image.name, category: image.category, versionId: version.id,
      version: version.version, templateId: remote.templateId, revisionId: remote.id, image: remote.image };
  }
  async acquireSelection(imageId: string, versionId: string) {
    return { selection: await this.resolve(imageId, versionId), release: async () => {} };
  }
  async acquireDefaultSelection() {
    const selected = await this.defaultSelection();
    if (!selected) throw new HttpError(503, '未配置系统默认 Cellbox template/revision');
    const images = await this.list();
    const image = images.find(value => value.templateId === selected.templateId || value.id === `cellbox:${selected.templateId}`);
    const version = image?.versions.find(value => value.revisionId === selected.revisionId);
    if (!image || !version) {
      const remote = await this.client.getTemplateRevision(selected.revisionId);
      const template = await this.client.getTemplate(selected.templateId);
      return { selection: { imageId: `cellbox:${template.id}`, imageName: template.name, category: '系统', versionId: remote.id,
        version: remote.version, templateId: remote.templateId, revisionId: remote.id, image: remote.image }, release: async () => {} };
    }
    return { selection: await this.resolveVersion(image, version), release: async () => {} };
  }
  async acquireRestoreSelection(project: Project, versionId?: string) {
    if (!project.imageSelection) {
      if (versionId) throw new HttpError(400, '系统默认镜像项目不能选择其他仓库版本');
      const selected = await this.acquireDefaultSelection();
      return selected;
    }
    if (project.imageSelection.migrationRequired || !project.imageSelection.templateId || !project.imageSelection.revisionId)
      throw new HttpError(409, '项目仍引用旧 importedImage，请先迁移项目镜像后再恢复');
    const images = await this.list();
    const image = images.find(value => value.templateId === project.imageSelection!.templateId);
    if (!image) throw new HttpError(409, '项目 Cellbox template 不可用');
    const selectedId = versionId ?? image.defaultVersionId ?? project.imageSelection.revisionId;
    const version = image.versions.find(value => value.id === selectedId || value.revisionId === selectedId);
    if (!version) throw new HttpError(409, '项目选择的 Cellbox revision 不可用');
    return { selection: await this.resolveVersion(image, version), release: async () => {} };
  }
  async setDefault(imageId: string, versionId: string): Promise<ManagedImage> {
    const images = await this.list();
    const image = images.find(value => value.id === imageId);
    const version = image?.versions.find(value => value.id === versionId);
    if (!image || !version) throw new HttpError(404, '镜像或版本不存在');
    const selection = await this.resolveVersion(image, version);
    await this.store.saveDefaultImage({ templateId: selection.templateId!, revisionId: selection.revisionId! });
    return (await this.list()).find(value => value.id === imageId)!;
  }
  async setDeprecated(imageId: string, versionId: string, deprecated: boolean): Promise<ManagedImage> {
    const images = await this.list();
    const image = images.find(value => value.id === imageId);
    const version = image?.versions.find(value => value.id === versionId);
    if (!image || !version) throw new HttpError(404, '镜像或版本不存在');
    if (!version.revisionId) throw new HttpError(409, '旧 importedImage 无法通过新接口退休，请先迁移');
    if (version.isDefault && deprecated) throw new HttpError(409, '请先切换 CoCell 默认 revision，再退休此版本');
    const remote = await this.client.getTemplateRevision(version.revisionId);
    const updated = await this.client.updateTemplateRevision(remote.id, {
      status: deprecated ? 'retired' : 'active', expectedGeneration: remote.generation,
    });
    const record = this.records.get(image.id);
    if (record) {
      const local = record.versions.find(value => value.revisionId === version.revisionId);
      if (local) {
        if (updated.status === 'retired') local.deprecatedAt = updated.updatedAt;
        else delete local.deprecatedAt;
        await this.save(record);
      }
    }
    return (await this.list()).find(value => value.id === imageId)!;
  }
  async removeRepository(imageId: string): Promise<void> {
    await this.loadRecords();
    const stored = this.records.get(imageId);
    if (!stored || stored.origin !== 'managed') throw new HttpError(404, '镜像仓库不存在');
    if (stored.deletedAt) return;
    if (stored.versions.some(version => version.revisionId && !version.deprecatedAt)) throw new HttpError(409, '请先退休仓库的所有版本');
    if ((await this.projects()).some(project => project.imageSelection?.imageId === imageId))
      throw new HttpError(409, '仍有项目引用此镜像仓库');
    const record = structuredClone(stored);
    record.deletedAt = new Date().toISOString();
    await this.save(record);
  }
  async usage(_imageId: string, _versionId: string): Promise<ImageVersionUsage> { return usageUnsupported(); }
  async removeVersion(_imageId: string, _versionId: string): Promise<ManagedImage> {
    throw new HttpError(410, 'Cellbox 不支持物理删除 revision；请通过版本操作将其退休');
  }
}
