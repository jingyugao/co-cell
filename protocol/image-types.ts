/** Image names group immutable versions; projects retain a selected version. */
export interface ImageVersion {
  id: string;
  version: string;
  source: string;
  status: 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  createdAt: string;
  importedImageId?: string;
  image?: string;
  resolvedSource?: string;
  upstreamDigest?: string;
  operationId?: string;
  registryAuthRequired?: boolean;
  projectReady?: boolean;
  buildCommand?: string;
  runCommand?: string;
  warnings?: string[];
  error?: string;
  cleanup?: { id: string; status: 'pending' | 'unknown' | 'failed'; operationId?: string; error?: string };
  deletedAt?: string;
  deprecatedAt?: string;
}
export interface ManagedImage {
  id: string;
  name: string;
  category: string;
  origin: 'managed' | 'cellbox' | 'profile';
  repository?: string;
  buildCommand?: string;
  registryAuthRequired?: boolean;
  defaultVersionId?: string;
  versions: ImageVersion[];
}
export interface ImageVersionUsage { deletable: boolean; blockers: string[]; manifestShared: boolean }
export interface ProjectImageSelection {
  imageId: string;
  imageName: string;
  category: string;
  versionId: string;
  version: string;
  importedImageId: string;
  image: string;
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
