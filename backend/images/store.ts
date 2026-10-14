import type { ManagedImage, ImageVersion, DefaultImageSelection } from '../../protocol/image-types.js';
import type { CellboxImportImageInput } from '../../packages/sandbox/src/providers/cellbox/client.js';

export interface ImageVersionRecord extends ImageVersion {
  /** Exact request retained for idempotent retry; registry credentials are never stored. */
  request: Omit<CellboxImportImageInput, 'registryAuth'>;
  /** Fingerprint of source + operator script + current CoCell packaging. */
  preparationKey?: string;
  requiresRegistryAuth: boolean;
}
export interface ImageRecord extends Omit<ManagedImage, 'versions'> {
  versions: ImageVersionRecord[];
  deletedAt?: string;
  /** Local lifecycle flags for versions discovered through Cellbox. */
  versionLifecycle?: Record<string, { deprecatedAt?: string }>;
}
export interface ImageCatalogStore {
  listImages(): Promise<ImageRecord[]>;
  saveImage(image: ImageRecord): Promise<void>;
  loadDefaultImage(): Promise<DefaultImageSelection | undefined>;
  saveDefaultImage(selection: DefaultImageSelection | undefined, image?: ImageRecord): Promise<void>;
}
