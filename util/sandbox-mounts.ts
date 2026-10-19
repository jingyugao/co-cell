import type { SandboxMount } from '../protocol/sandbox-types.js';

/** homeVolumeId is Cellbox's shorthand for a /home/agent mount. */
export function sandboxMounts(value: { mounts?: SandboxMount[]; homeVolumeId?: string }): SandboxMount[] | undefined {
  if (value.mounts?.length) return structuredClone(value.mounts);
  if (value.homeVolumeId) return [{ volumeId: value.homeVolumeId, mountPath: '/home/agent' }];
}
