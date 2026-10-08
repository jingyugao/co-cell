import type { ImageVersion } from '../protocol/image-types.js';

export function availableImageVersions(versions: ImageVersion[]): ImageVersion[] {
  return versions.filter(version => version.status === 'succeeded' && !version.deletedAt && !version.deprecatedAt
    && !version.cleanup && version.projectReady !== false).sort((a, b) => {
    const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(value);
    const left = parse(a.version), right = parse(b.version);
    if (!!left !== !!right) return left ? -1 : 1;
    if (left && right) {
      for (const i of [1, 2, 3]) { const diff = Number(right[i]) - Number(left[i]); if (diff) return diff; }
      if (!left[4] !== !right[4]) return left[4] ? 1 : -1;
      const l = left[4]?.split('.') ?? [], r = right[4]?.split('.') ?? [];
      for (let i = 0; i < Math.max(l.length, r.length); i++) {
        if (l[i] === undefined) return 1;
        if (r[i] === undefined) return -1;
        if (l[i] === r[i]) continue;
        const ln = /^\d+$/.test(l[i]), rn = /^\d+$/.test(r[i]);
        if (ln !== rn) return ln ? 1 : -1;
        return ln ? Number(r[i]) - Number(l[i]) : r[i].localeCompare(l[i], 'en');
      }
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}
