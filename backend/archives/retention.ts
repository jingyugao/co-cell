import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { RemoteArchives } from './remote.js';

/** Keep the latest archive and remove older references only after Cellbox deletion succeeds. */
export async function pruneRemoteArchives(references: readonly RemoteArchiveRef[], keep: number,
  remote: RemoteArchives, removeReference: (id: string) => Promise<void>): Promise<number> {
  const retained = Math.max(1, Number.isInteger(keep) ? keep : 2);
  if (references.length <= retained) return 0;
  if (!remote.remove) throw new Error('Cellbox 归档清理不可用');
  let removed = 0;
  for (const reference of references.slice(retained)) {
    if (reference.id === references[0]?.id) continue;
    await remote.remove(reference);
    await removeReference(reference.id);
    removed++;
  }
  return removed;
}
