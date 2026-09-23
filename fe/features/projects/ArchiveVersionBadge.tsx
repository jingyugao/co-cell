import { useId } from 'react';
import type { ProjectSummary } from '../../../protocol/types';

type ArchiveVersion = NonNullable<ProjectSummary['archiveVersions']>[number];
type Props = { project: ProjectSummary; onView: (archiveKey: string, versionId: string | undefined,
  meta: { sizeBytes: number; bytesAdded?: number; createdAt: string }) => void };

function fmtSize(bytes: number) {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
function fmtDate(ts: string) {
  try { return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { return ts; }
}

export default function ArchiveVersionBadge({ project, onView }: Props) {
  const tooltipId = useId();
  const versions: ArchiveVersion[] = (project.archiveVersions && project.archiveVersions.length > 0)
    ? project.archiveVersions
    : project.sandboxDataArchive
      ? [{ sizeBytes: project.sandboxDataArchive.sizeBytes, createdAt: project.sandboxDataArchive.createdAt,
        label: project.sandboxDataArchive.sha256.slice(0, 8), version: 0, id: project.sandboxDataArchive.key }]
      : [];
  if (!versions.length) return null;

  const latest = versions[0];
  const key = project.archiveKey || project.sandboxDataArchive?.key || latest.id;

  function handleClick(v: ArchiveVersion) {
    onView(key, project.archiveKey ? v.id : undefined,
      { sizeBytes: v.sizeBytes, bytesAdded: v.bytesAdded, createdAt: v.createdAt });
  }

  return <span className="archive-badge" tabIndex={0} aria-describedby={tooltipId}>
    <span className="archive-badge-label">
      {fmtDate(latest.createdAt)}
      {versions.length > 1 && <span className="archive-badge-count">{versions.length}</span>}
    </span>
    <span className="archive-badge-popover" id={tooltipId} role="tooltip">
      <strong>归档版本</strong>
      <span className="archive-badge-chain">
        {versions.map((v, i) => (
          <button
            className={`archive-badge-entry${i === 0 ? ' is-latest' : ''}`}
            key={v.id}
            onClick={() => handleClick(v)}
          >
            <code>{fmtSize(v.sizeBytes)}{v.bytesAdded === undefined ? '' : ` · +${fmtSize(v.bytesAdded)}`}</code>
            <time dateTime={v.createdAt}>{fmtDate(v.createdAt)}</time>
            <em>{v.label}</em>
            {i < versions.length - 1 && <i aria-hidden="true">↓</i>}
          </button>
        ))}
      </span>
    </span>
  </span>;
}
