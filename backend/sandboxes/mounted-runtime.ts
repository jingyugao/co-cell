import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolRuntimeMount } from '../../protocol/secret-types.js';

const guestRoot = '/var/lib/cellbox/shared';
export function mountedRuntime(root: string, boxId: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,54}$/.test(boxId)) throw new Error('Invalid mounted runtime identity');
  const relative = `runtime/boxes/${boxId}/tool-runtime.json`;
  const directory = join(root, 'runtime', 'boxes', boxId);
  const destination = join(root, relative);
  const descriptor: ToolRuntimeMount = { mode: 'mount', path: `${guestRoot}/${relative}` };
  return {
    descriptor,
    read: () => readFile(destination),
    async publish(bytes: Uint8Array) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temp = join(directory, `.tool-runtime-${randomUUID()}`);
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await rename(temp, destination);
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      } finally { await rm(temp, { force: true }); }
    },
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
