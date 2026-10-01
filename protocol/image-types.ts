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
  operationId?: string;
  registryAuthRequired?: boolean;
  projectReady?: boolean;
  buildCommand?: string;
  runCommand?: string;
  warnings?: string[];
  error?: string;
}
export interface ManagedImage {
  id: string;
  name: string;
  category: string;
  origin: 'managed' | 'cellbox' | 'profile';
  versions: ImageVersion[];
}
export interface ProjectImageSelection {
  imageId: string;
  imageName: string;
  category: string;
  versionId: string;
  version: string;
  importedImageId: string;
  image: string;
}
export interface ImportImageInput {
  imageId?: string;
  name?: string;
  category?: string;
  version: string;
  url: string;
  buildCommand?: string;
  registryAuth?: { username: string; password: string };
}
