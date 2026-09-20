export interface SandboxImage {
  reference: string;
  id: string;
}

export interface SandboxBundle {
  id: string;
  image: SandboxImage;
  path: string;
  rootfs: string;
  configPath: string;
}

/** OCI process and bind mounts required by a provider at sandbox creation. */
export interface SandboxBundleOptions {
  process?: {
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    uid?: number;
    gid?: number;
  };
  mounts?: Array<{ source: string; destination: string; readonly?: boolean }>;
  /** Existing host network namespace that runsc should import into netstack. */
  networkNamespace?: string;
}

export interface SandboxImageManager {
  inspect(reference: string): Promise<SandboxImage>;
  prepareBundle(image: SandboxImage, sandboxId: string, options?: SandboxBundleOptions): Promise<SandboxBundle>;
  removeBundle(bundle: SandboxBundle): Promise<void>;
}
