import { randomUUID } from 'node:crypto';
import { CellboxClient, CellboxError, type CellboxImportedImage } from '../../packages/sandbox/src/providers/cellbox/client.js';
import type { ManagedImage, ImportImageInput, ProjectImageSelection } from '../../protocol/image-types.js';
import type { ImageCatalogStore, ImageRecord, ImageVersionRecord } from './store.js';
import { prepareImageRequest } from './build-command.js';
import { HttpError } from '../../util/errors.js';

const publicImage = (record: ImageRecord): ManagedImage => ({ ...record,
  versions: record.versions.map(({ request: _request, requiresRegistryAuth, ...version }) => ({ ...version, registryAuthRequired: requiresRegistryAuth })) });

export class ImageCatalog {
  private records = new Map<string, ImageRecord>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: ImageCatalogStore, private client: CellboxClient, private profileId: string) {}
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
      if (changed) await this.save(record);
    }
  }
  private external(images: CellboxImportedImage[]): ManagedImage[] {
    const known = new Set([...this.records.values()].flatMap(image => image.versions.map(version => version.importedImageId)));
    const groups = new Map<string, ManagedImage>();
    for (const image of images) {
      if (known.has(image.id)) continue;
      const source = image.source;
      const repository = source.replace(/@.*$/, '').replace(/:[^/]+$/, '');
      const id = `cellbox:${repository}`;
      const group = groups.get(id) ?? { id, name: repository, category: '已导入', origin: 'cellbox' as const, versions: [] };
      group.versions.push({ id: image.id, version: source.includes('@') ? source.split('@')[1] : source.slice(repository.length + 1) || 'latest',
        source, status: 'succeeded', importedImageId: image.id, image: image.image, resolvedSource: image.resolvedSource,
        projectReady: image.command[0] === '/usr/local/bin/node' && image.command[1] === '/opt/product/cocell/launcher.mjs',
        warnings: image.warnings, createdAt: image.createdAt });
      groups.set(id, group);
    }
    return [...groups.values()];
  }
  list(): Promise<ManagedImage[]> {
    return this.exclusive(async () => {
      await this.refresh();
      const [images, profiles] = await Promise.all([this.client.listImages(), this.client.listProfiles()]);
      const profile = profiles.find(profile => profile.id === this.profileId);
      const builtin: ManagedImage[] = profile ? [{ id: 'default', name: '系统默认镜像', category: '系统', origin: 'profile',
        versions: [{ id: 'default', version: '当前配置', source: profile.image, image: profile.image, status: 'succeeded', createdAt: '' }] }] : [];
      return [...builtin, ...[...this.records.values()].map(publicImage), ...this.external(images)];
    });
  }
  import(input: ImportImageInput): Promise<ManagedImage> {
    return this.exclusive(async () => {
      await this.refresh();
      if ([...this.records.values()].some(image => image.versions.some(version => ['queued', 'running'].includes(version.status))))
        throw new HttpError(409, '已有镜像正在构建，请等待完成后再导入');
      let stored = input.imageId ? this.records.get(input.imageId) : undefined;
      if (!stored && input.imageId?.startsWith('cellbox:')) {
        const existing = this.external(await this.client.listImages()).find(image => image.id === input.imageId);
        if (existing) stored = { ...existing, id: randomUUID(), origin: 'managed',
          versions: existing.versions.map(version => ({ ...version, request: { url: version.source }, requiresRegistryAuth: false })) };
      }
      if (input.imageId && !stored) throw new HttpError(404, '镜像不存在或不支持新增版本');
      if (!stored) {
        if (!input.name?.trim() || !input.category?.trim()) throw new HttpError(400, '请输入镜像名称和类型');
        if ([...this.records.values()].some(image => image.name === input.name!.trim() && image.category === input.category!.trim()))
          throw new HttpError(409, '同类型镜像名称已存在，请在该镜像中新增版本');
        stored = { id: randomUUID(), name: input.name.trim(), category: input.category.trim(), origin: 'managed', versions: [] };
      }
      if (stored.versions.some(version => version.version === input.version)) throw new HttpError(409, '版本名称已存在，请使用新的版本名称');
      const request = await prepareImageRequest(input.url, input.buildCommand);
      const record = structuredClone(stored);
      const version: ImageVersionRecord = { id: randomUUID(), version: input.version, source: input.url,
        status: 'submitting', createdAt: new Date().toISOString(), request, projectReady: true, requiresRegistryAuth: Boolean(input.registryAuth),
        ...(input.buildCommand ? { buildCommand: input.buildCommand } : {}), runCommand: request.runCommand };
      record.versions.unshift(version);
      // Save the exact request and key before submitting any external mutation.
      await this.save(record);
      await this.submit(record, version, input.registryAuth);
      return publicImage(this.records.get(record.id)!);
    });
  }
  retry(imageId: string, versionId: string, auth?: ImportImageInput['registryAuth']) {
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
  private async submit(record: ImageRecord, version: ImageVersionRecord, registryAuth?: ImportImageInput['registryAuth'], retry = false) {
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
    const image = (await this.list()).find(image => image.id === imageId);
    const version = image?.versions.find(version => version.id === versionId);
    if (!image || !version) throw new HttpError(404, '镜像或版本不存在');
    if (version.status !== 'succeeded') throw new HttpError(409, '请选择已导入成功的镜像版本');
    if (version.projectReady === false) throw new HttpError(409, '此版本尚未配置 CoCell 启动器，请通过新增版本重新导入');
    if (image.origin === 'profile') return undefined;
    if (!version.importedImageId || !version.image) throw new HttpError(409, '镜像版本尚未就绪');
    const remote = await this.client.getImage(version.importedImageId);
    if (remote.image !== version.image) throw new HttpError(409, '镜像身份与版本记录不一致');
    return { imageId: image.id, imageName: image.name, category: image.category, versionId: version.id,
      version: version.version, importedImageId: remote.id, image: remote.image };
  }
}
