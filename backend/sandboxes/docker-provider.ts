import type { SandboxCommandHandle, SandboxCommandResult, SandboxHandle, SandboxProvider } from '@co-cell/sandbox';
import { DockerSandboxClient } from '../../packages/docker-sandbox/src/index.js';

/** Adapts trusted local Docker containers to the provider-neutral coordinator. */
export function dockerSandboxProvider(client: DockerSandboxClient): SandboxProvider & {
  archive(id: string, destination: string): Promise<{ sizeBytes: number; sha256: string }>;
  restoreArchive(id: string, archivePath: string): Promise<void>;
  stop(id: string): Promise<void>;
} {
  const sandbox = (id: string): SandboxHandle => ({
    sandboxId: id,
    setTimeout: async (_timeoutMs: number) => {},
    getHost: (_port: number) => '127.0.0.1',
    commands: { run: async (command: string, options: { timeoutMs?: number; envs?: Record<string, string>; cwd?: string; background?: boolean; user?: string; signal?: AbortSignal; onStdout?: (value: string) => void; onStderr?: (value: string) => void } = {}): Promise<SandboxCommandResult | SandboxCommandHandle> => {
      if (options.background) {
        const handle = client.execAttached(id, command, {
          timeoutMs: options.timeoutMs, env: options.envs, cwd: options.cwd, user: options.user,
          signal: options.signal,
          onStdout: options.onStdout, onStderr: options.onStderr,
        });
        return {
          wait: async () => {
            const result = await handle.wait();
            if (result.exitCode) throw Object.assign(new Error(result.stderr || `exit ${result.exitCode}`), result);
            return result;
          },
          kill: () => handle.kill(),
          disconnect: () => handle.disconnect(),
        } satisfies SandboxCommandHandle;
      }
      const result = await client.exec(id, command, { timeoutMs: options.timeoutMs, env: options.envs, cwd: options.cwd, user: options.user, signal: options.signal });
      if (result.exitCode) { const error = Object.assign(new Error(result.stderr || `exit ${result.exitCode}`), result); throw error; }
      return result;
    } } as SandboxHandle['commands'],
    files: {
      read: async (path: string) => (await client.readFile(id, path)).toString(),
      write: async (path: string, value: Uint8Array | string, options: { user?: string } = {}) => client.writeFile(id, path, Buffer.from(value), options.user ?? client.defaultUser),
      exists: async (path: string) => (await client.exec(id, `test -e ${JSON.stringify(path)}`)).exitCode === 0,
      remove: async (path: string) => { await client.exec(id, `rm -rf -- ${JSON.stringify(path)}`); },
      rename: async (from: string, to: string) => { const result = await client.exec(id, `mv -- ${JSON.stringify(from)} ${JSON.stringify(to)}`); if (result.exitCode) throw new Error(result.stderr); },
    },
  });
  return {
    create: async (_image, options) => sandbox((await client.create(
      options.metadata?.projectId ?? 'session', options.metadata?.workingDirectory ?? '/home/user/workspace',
    )).id),
    connect: async id => {
      const state = await client.inspect(id);
      if (state === 'paused') await client.resume(id);
      else if (state !== 'ready') throw new Error(`Docker Sandbox ${id} is unavailable`);
      return sandbox(id);
    },
    getInfo: async id => {
      const details = await client.containerDetails(id);
      const state = details.status;
      const now = new Date();
      return { sandboxId: id, state: state === 'paused' ? 'paused' : state === 'ready' ? 'running' : 'unknown',
        startedAt: new Date(details.createdAt), endAt: new Date(now.getTime() + 3 * 60 * 60 * 1000), metadata: { app: 'codex-web' },
        templateIdentity: details.imageIdentity };
    },
    pause: async id => { await client.pause(id); return true; },
    kill: async id => { await client.remove(id); return true; },
    archive: (id, destination) => client.archive(id, destination),
    restoreArchive: (id, archivePath) => client.restoreArchive(id, archivePath),
    stop: id => client.stop(id),
  };
}
