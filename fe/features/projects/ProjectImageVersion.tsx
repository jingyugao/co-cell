import { useEffect, useId, useRef, useState } from 'react';
import type { ImageVersion, ManagedImage, ProjectImageSelection } from '../../../protocol/image-types';
import { availableImageVersions } from '../../../util/image-versions';
import { api } from '../../lib/api';
import './ProjectImageVersion.css';

function UpgradeDialog({ selection, version, disabled, onUpgrade, onClose }: {
  selection: ProjectImageSelection; version: ImageVersion; disabled: boolean;
  onUpgrade: (id: string) => Promise<unknown>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog className="image-upgrade-dialog" ref={dialog} aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section>
      <h2 id={heading}>升级项目镜像</h2>
      <p className="image-upgrade-name">{selection.imageName}</p>
      <div className="image-upgrade-transition"><span>{selection.version}<small>当前版本</small></span><span aria-hidden="true">→</span><span>{version.version}<small>目标版本</small></span></div>
      <p>保留挂载磁盘中的最新文件和会话历史。升级会停止当前进程，旧 Checkpoint 将失效，服务需要重新启动。</p>
      {error && <p className="project-error" role="alert">{error}</p>}
      <div className="image-upgrade-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={busy || disabled} onClick={async () => {
          setBusy(true); setError('');
          try { await onUpgrade(version.id); onClose(); }
          catch (err) { setError(err instanceof Error ? err.message : '升级请求失败，请重试。'); }
          finally { setBusy(false); }
        }}>{busy ? '正在提交…' : '确认升级'}</button></div>
    </section>
  </dialog>;
}

export default function ProjectImageVersion({ selection, disabled, onUpgrade }: {
  selection: ProjectImageSelection; disabled: boolean; onUpgrade: (id: string) => Promise<unknown>;
}) {
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false);
  const [image, setImage] = useState<ManagedImage>(), [error, setError] = useState('');
  const [selected, setSelected] = useState<ImageVersion>();
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 320, transform: 'none' });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void api<ManagedImage[]>('/api/images', { signal: controller.signal }).then(images => {
      if (controller.signal.aborted) return;
      const found = images.find(value => value.id === selection.imageId);
      setImage(found);
      if (!found) setError('镜像仓库已不可用');
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '版本读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, selection.imageId]);
  function show() {
    if (selected || !trigger.current || !popup.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 16;
    const above = below < 180 && rect.top - 16 > below;
    setPosition({ left: Math.max(16, Math.min(rect.left, window.innerWidth - 320)),
      top: above ? rect.top : rect.bottom,
      maxHeight: Math.max(100, Math.min(320, above ? rect.top - 16 : below)),
      transform: above ? 'translateY(-100%)' : 'none' });
    if (!popup.current.matches(':popover-open')) popup.current.showPopover();
  }
  const versions = availableImageVersions(image?.versions ?? []);
  const latest = versions[0];
  return <span className="project-image-version" onMouseEnter={show} onMouseLeave={event => {
    if (!event.currentTarget.contains(document.activeElement)) popup.current?.hidePopover();
  }}>
    <button ref={trigger} className="project-image-trigger" aria-expanded={open} aria-controls={popupId} aria-label={`${selection.imageName} · ${selection.version}，查看版本`} onClick={show}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show(); } }}>
      {selection.imageName} · {selection.version}<span aria-hidden="true"> ▾</span>
    </button>
    <div ref={popup} id={popupId} popover="auto" className="project-image-popover" style={position} role="region" aria-label="镜像版本列表" onToggle={event => setOpen(event.newState === 'open')}>
      <strong>镜像版本</strong>
      {loading ? <p role="status">正在读取版本…</p> : error ? <p role="alert">{error}</p> : <>
        <p>{latest?.id === selection.versionId ? '当前已是最新可用版本' : '选择版本，查看升级详情'}</p>
        <ul>{versions.map(version => <li key={version.id}><button disabled={disabled || version.id === selection.versionId} onClick={() => { popup.current?.hidePopover(); setSelected(version); }}>
          <span>{version.version}</span><span className="image-version-labels">{version.id === selection.versionId && <small>当前</small>}{version.id === latest?.id && <small>最新</small>}{version.id === image?.defaultVersionId && <small>默认</small>}</span>
        </button></li>)}</ul>
        {!versions.some(version => version.id === selection.versionId) && <p>当前版本：{selection.version}（已不可选）</p>}
        {!versions.length && <p>暂无可用版本</p>}
        {disabled && <p>请等待项目空闲且环境可操作后升级。</p>}
      </>}
    </div>
    {selected && <UpgradeDialog selection={selection} version={selected} disabled={disabled} onUpgrade={onUpgrade}
      onClose={() => { setSelected(undefined); trigger.current?.focus(); }} />}
  </span>;
}
