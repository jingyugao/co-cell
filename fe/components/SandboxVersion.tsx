import { useId } from 'react';
import type { SandboxImageIdentity } from '../../protocol/sandbox-types';
import './SandboxVersion.css';
import './SandboxVersionDetails.css';

export interface SandboxVersionItem {
  version: string;
  createdAt?: string;
  current?: boolean;
}

export interface SandboxVersionProps {
  image?: SandboxImageIdentity;
  latestImage?: SandboxImageIdentity;
  className?: string;
  onSwitchToLatest?: () => void;
}

const date = (value: string | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { hour12: false })
  : null;

const imageVersion = (image: SandboxImageIdentity) => image.version?.trim()
  || image.reference.match(/:([^/:@]+)$/)?.[1]?.replace(/^latest$/, '')
  || image.id.replace(/^sha256:/, '').slice(0, 12);

/** Compact image-version indicator with an accessible hover/focus version chain. */
export function SandboxVersion({ image, latestImage, className = '', onSwitchToLatest }: SandboxVersionProps) {
  const tooltipId = useId();
  if (!image) return null;
  const isLatest = Boolean(latestImage?.id && latestImage.id === image.id);
  const currentVersion = imageVersion(image);
  const label = isLatest ? 'latest' : currentVersion;
  const entries: SandboxVersionItem[] = isLatest
    ? [{ version: currentVersion, createdAt: image.createdAt, current: true }]
    : latestImage
      ? [
          { version: imageVersion(latestImage), createdAt: latestImage.createdAt },
          { version: currentVersion, createdAt: image.createdAt, current: true },
        ]
      : [{ version: currentVersion, createdAt: image.createdAt, current: true }];
  return <span
    className={`sandbox-version${isLatest ? ' latest' : ' outdated'}${className ? ` ${className}` : ''}`}
    tabIndex={entries.length ? 0 : undefined}
    aria-describedby={entries.length ? tooltipId : undefined}
  >
    <span className="sandbox-version-label">{label}</span>
    {entries.length > 0 && <span className="sandbox-version-popover" id={tooltipId} role="tooltip">
      <strong>Sandbox 版本链</strong>
      <span className="sandbox-version-chain">
        {entries.map((item, index) => <span className={`sandbox-version-entry${item.current ? ' current' : ''}`} key={`${item.version}-${index}`}>
          <span className="sandbox-version-entry-value"><span>{item.version}</span></span>
          {date(item.createdAt) && <time dateTime={item.createdAt}>{date(item.createdAt)}</time>}
          {index < entries.length - 1 && <i aria-hidden="true">↓</i>}
        </span>)}
      </span>
      {onSwitchToLatest && <button type="button" className="sandbox-version-switch" onClick={event => {
        event.preventDefault(); event.stopPropagation(); onSwitchToLatest();
      }}>切换到最新版本</button>}
    </span>}
  </span>;
}
