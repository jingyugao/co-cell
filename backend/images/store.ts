import type { ManagedImage, ImageVersion, DefaultImageSelection } from '../../protocol/image-types.js';

export interface ImageVersionRecord extends ImageVersion {
  userVersion?: string;
  /** Legacy imported-image metadata retained only so old JSON can be loaded safely. */
  request?: unknown;
  preparationKey?: string;
  requiresRegistryAuth?: boolean;
}
export interface ImageRecord extends Omit<ManagedImage, 'versions'> {
  versions: ImageVersionRecord[];
  deletedAt?: string;
  /** Old imported-image records stay visible until an operator migrates them. */
  legacyImport?: boolean;
}
export interface ImageCatalogStore {
  listImages(): Promise<ImageRecord[]>;
  saveImage(image: ImageRecord): Promise<void>;
  loadDefaultImage(): Promise<DefaultImageSelection | undefined>;
  saveDefaultImage(selection: DefaultImageSelection | undefined, image?: ImageRecord): Promise<void>;
}
