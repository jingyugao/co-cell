/** Immutable OCI image identity captured by the selected sandbox backend. */
export interface SandboxImageIdentity {
  /** Mutable reference requested by the service, for example `cellbox:latest`. */
  reference: string;
  /** Docker content ID or an immutable registry reference (`repository@sha256:...`). */
  id: string;
  /** Registry content digests, when the image was pulled from a registry. */
  repoDigests: string[];
  /** Human-readable build version supplied by the OCI image label. */
  version?: string;
  /** Image build timestamp supplied by Docker/OCI metadata. */
  createdAt?: string;
}

/** Cellbox owns the volume and its lifetime; mounting does not reserve it. */
export interface SandboxMount {
  volumeId: string;
  mountPath: string;
  readOnly?: boolean;
}

/** Sandbox reference and live observation; status is never persisted by CoCell. */
export interface SandboxState {
  ownerKey?: string;
  mounts?: SandboxMount[];
  homeVolumeId?: string;
  /** Request-local observations from Cellbox; never used as a resource lock. */
  phase?: string;
  generation?: number;
  operationId?: string;
  observedAt?: string;
  lastActiveAt?: string;
  pausedAt?: string;
  id: string;
  /** Project reads observe Cellbox; session lists only include reference metadata.
   * unknown means no live observation is available. */
  status: 'starting' | 'ready' | 'paused' | 'unavailable' | 'unknown';
  template: string;
  /** Optional for backward compatibility with Sandbox records created before image tracking. */
  image?: SandboxImageIdentity;
  workingDirectory: string;
}
