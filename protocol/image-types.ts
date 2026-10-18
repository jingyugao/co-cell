/** CoCell's product catalog groups Cellbox templates into named repositories. */
export interface ImageVersion {
  /** CoCell's selected default revision for new projects. */
  isDefault?: boolean;
  id: string;
  version: string;
  userVersion?: string;
  source: string;
  status: 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  createdAt: string;
  templateId?: string;
  revisionId?: string;
  /** Legacy imported image identity. It is not a Cellbox revision identifier. */
  importedImageId?: string;
  image?: string;
  resolvedSource?: string;
  upstreamDigest?: string;
  operationId?: string;
  registryAuthRequired?: boolean;
  projectReady?: boolean;
  migrationRequired?: boolean;
  buildCommand?: string;
  runCommand?: string;
  warnings?: string[];
  error?: string;
  deprecatedAt?: string;
  /** Legacy cleanup status from the imported-image catalog. */
  cleanup?: { id: string; status: 'pending' | 'unknown' | 'failed'; operationId?: string; error?: string };
}
export interface DefaultImageSelection {
  templateId: string;
  revisionId: string;
  /** Old persisted settings are kept visible but never treated as revisions. */
  imageId?: string;
  versionId?: string;
}
export interface ManagedImage {
  id: string;
  name: string;
  category: string;
  origin: 'managed' | 'cellbox' | 'profile';
  templateId?: string;
  repository?: string;
  buildCommand?: string;
  registryAuthRequired?: boolean;
  defaultVersionId?: string;
  versions: ImageVersion[];
  migrationRequired?: boolean;
  templateStatus?: 'submitting' | 'ready' | 'failed' | 'unknown';
  error?: string;
}
export interface ImageVersionUsage { deletable: boolean; blockers: string[]; manifestShared: boolean }
export interface ProjectImageSelection {
  imageId: string;
  imageName: string;
  category: string;
  versionId: string;
  version: string;
  templateId?: string;
  revisionId?: string;
  /** Legacy identifier retained for display/migration only. */
  importedImageId?: string;
  image: string;
  migrationRequired?: boolean;
}
export interface RegistryAuth { username: string; password: string }
export interface AddImageRepositoryInput {
  name: string;
  category: string;
  repository: string;
  buildCommand?: string;
  registryAuthRequired?: boolean;
}
export interface RegistryTagsPage { tags: string[]; next?: string }
export interface SyncImageVersionInput {
  tag: string;
  registryAuth?: RegistryAuth;
}
