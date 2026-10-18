import { useId } from 'react';
import type { ProjectSummary } from '../../../protocol/types';

type ArchiveVersion = NonNullable<ProjectSummary['archiveVersions']>[number];
type Props = { project: ProjectSummary; onView: (archiveKey: string, versionId: string | undefined,
  meta: { sizeBytes?: number; bytesAdded?: number; createdAt: string }) => void };

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
  const versions: ArchiveVersion[] = project.archiveVersions ?? [];
  if (!versions.length) return null;

  const latest = versions[0];
  const key = latest.id;
  const latestBrowsable = latest.browsable !== false && latest.storageType !== 'cellbox-volume';
  const volumeBackup = !latestBrowsable;

  function handleClick(v: ArchiveVersion) {
    if (v.browsable === false || v.storageType === 'cellbox-volume') return;
    onView(key, v.id,
      { sizeBytes: v.sizeBytes, bytesAdded: v.bytesAdded, createdAt: v.createdAt });
  }

  const sizeLabel = (v: ArchiveVersion) => v.sizeBytes === undefined ? '' : `${fmtSize(v.sizeBytes)}${v.bytesAdded === undefined ? '' : ` · +${fmtSize(v.bytesAdded)}`}`;

  return <span className={`archive-badge${volumeBackup ? ' volume-backup' : ''}`} tabIndex={versions.some(v => v.browsable !== false && v.storageType !== 'cellbox-volume') ? 0 : undefined} aria-describedby={tooltipId}>
    <span className="archive-badge-label" title={volumeBackup ? '磁盘备份，暂不支持文件浏览' : undefined}>
      {volumeBackup ? '磁盘备份 · ' : ''}{fmtDate(latest.createdAt)}{latest.sizeBytes === undefined ? '' : ` · ${sizeLabel(latest)}`}
      {versions.length > 1 && <span className="archive-badge-count">{versions.length}</span>}
    </span>
    {volumeBackup && <span className="archive-badge-volume-note">暂不支持文件浏览</span>}
    <span className="archive-badge-popover" id={tooltipId} role="tooltip">
      <strong>归档版本</strong>
      <span className="archive-badge-chain">
        {versions.map((v, i) => {
          const browsable = v.browsable !== false && v.storageType !== 'cellbox-volume';
          const entry = <><code>{sizeLabel(v)}</code><time dateTime={v.createdAt}>{fmtDate(v.createdAt)}</time><em>{browsable ? v.label : '磁盘备份，暂不支持文件浏览'}</em>{i < versions.length - 1 && <i aria-hidden="true">↓</i>}</>;
          return browsable
            ? <button className={`archive-badge-entry${i === 0 ? ' is-latest' : ''}`} key={v.id} onClick={() => handleClick(v)}>{entry}</button>
            : <span className={`archive-badge-entry${i === 0 ? ' is-latest' : ''}`} key={v.id} aria-label="磁盘备份，暂不支持文件浏览">{entry}</span>;
        })}
      </span>
    </span>
  </span>;
}
