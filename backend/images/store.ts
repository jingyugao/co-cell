import type { ManagedImage, ImageVersion } from '../../protocol/image-types.js';
import type { CellboxImportImageInput } from '../../packages/sandbox/src/providers/cellbox/client.js';

export interface ImageVersionRecord extends ImageVersion {
  /** Exact request retained for idempotent retry; registry credentials are never stored. */
  request: Omit<CellboxImportImageInput, 'registryAuth'>;
  requiresRegistryAuth: boolean;
}
export interface ImageRecord extends Omit<ManagedImage, 'versions'> { versions: ImageVersionRecord[] }
export interface ImageCatalogStore {
  listImages(): Promise<ImageRecord[]>;
  saveImage(image: ImageRecord): Promise<void>;
}
