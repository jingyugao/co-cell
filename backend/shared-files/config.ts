import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const schema = z.object({ sharedDirectory: z.object({
  enabled: z.boolean(), hostPath: z.string(), nodeName: z.string(),
}).strict() }).strict();

export async function loadSharedMountConfig(path = process.env.COCELL_MOUNTS_CONFIG) {
  if (!path) return false;
  const { sharedDirectory } = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (sharedDirectory.enabled && (!sharedDirectory.hostPath.startsWith('/') || sharedDirectory.hostPath === '/' || !sharedDirectory.nodeName.trim())) {
    throw new Error('Enabled shared directory requires hostPath and nodeName');
  }
  return sharedDirectory.enabled;
}
