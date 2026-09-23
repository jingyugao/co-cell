export type DockerSandboxStatus = 'ready' | 'paused' | 'unavailable';
export type DockerImageIdentity = {
  reference: string;
  id: string;
  repoDigests: string[];
  version?: string;
  createdAt?: string;
};
export type DockerSandboxRecord = { id: string; image: string; imageIdentity?: DockerImageIdentity; status: DockerSandboxStatus; projectId: string; workingDirectory: string; createdAt: string; generation?: string };
export type DockerExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  user?: string;
  signal?: AbortSignal;
  onStdout?: (value: string) => void;
  onStderr?: (value: string) => void;
};
export type DockerExecResult = { stdout: string; stderr: string; exitCode: number };
export type DockerArchiveDataOptions = {
  /** Host-side root for persistent, per-project archive command storage. */
  root: string;
  /** Path as visible to the Docker daemon when it differs from this process. */
  dockerRoot?: string;
  /** Sandbox-side base path; each project is mounted at `<sandboxRoot>/<projectId>`. */
  sandboxRoot?: string;
  uid: number;
  gid: number;
};
export type DockerArchiveData = { projectId: string; root: string; sandboxRoot: string };
export type DockerExecHandle = {
  wait(): Promise<DockerExecResult>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
};
