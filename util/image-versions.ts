import type { ImageVersion } from '../protocol/image-types.js';

/** Newest builds first, with deterministic ordering for equal or missing timestamps. */
export function compareImageVersions(a: ImageVersion, b: ImageVersion): number {
  const createdAt = (version: ImageVersion) => {
    const timestamp = Date.parse(version.createdAt);
    return Number.isFinite(timestamp) ? timestamp : -Infinity;
  };
  const aTime = createdAt(a), bTime = createdAt(b);
  if (aTime !== bTime) return aTime > bTime ? -1 : 1;
  return b.version.localeCompare(a.version, 'en', { numeric: true }) || b.id.localeCompare(a.id);
}
