/** Docker image identity captured when a Sandbox container is created. */
export interface SandboxImageIdentity {
  /** Mutable reference requested by the service, for example `cellbox:latest`. */
  reference: string;
  /** Immutable Docker image content ID (`sha256:...`). */
  id: string;
  /** Registry content digests, when the image was pulled from a registry. */
  repoDigests: string[];
  /** Human-readable build version supplied by the OCI image label. */
  version?: string;
  /** Image build timestamp supplied by Docker/OCI metadata. */
  createdAt?: string;
}

/** Persisted sandbox metadata; independent of conversation history. */
export interface SandboxState {
  lastActiveAt?: string;
  pausedAt?: string;
  id: string;
  status: 'starting' | 'ready' | 'paused' | 'unavailable';
  template: string;
  /** Optional for backward compatibility with Sandbox records created before image tracking. */
  image?: SandboxImageIdentity;
  workingDirectory: string;
}
