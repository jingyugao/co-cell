import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';
// ArchiveBrowser.css no longer needed — styles in styles.css

type FileEntry = { name: string; type: 'file' | 'directory'; size: number; mtime?: string };

function fmtSize(bytes: number) {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtTime(ts: string) {
  try { return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { return ts; }
}

function fmtMtime(ts?: string) {
  if (!ts) return '—';
  return fmtTime(ts);
}

type Props = {
  archiveKey: string;
  archiveMeta: { sizeBytes: number; createdAt: string; sha256: string } | null;
  onClose: () => void;
};

export default function ArchiveViewer({ archiveKey, archiveMeta, onClose }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [viewingFile, setViewingFile] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api<{ entries: FileEntry[]; rootPrefix: string }>(`/api/archives/${encodeURIComponent(archiveKey)}/files`)
      .then(r => setFiles(r.entries))
      .catch(e => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [archiveKey]);

  const navigateTo = useCallback(async (path: string) => {
    setCurrentPath(path);
    setViewingFile(null);
    setLoading(true);
    try {
      const r = await api<{ entries: FileEntry[] }>(`/api/archives/${encodeURIComponent(archiveKey)}/files?path=${encodeURIComponent(path)}`);
      setFiles(r.entries);
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, [archiveKey]);

  const viewFile = useCallback(async (filePath: string) => {
    setViewingFile(null);
    setLoading(true);
    try {
      const r = await api<{ content: string; truncated: boolean }>(`/api/archives/${encodeURIComponent(archiveKey)}/file?path=${encodeURIComponent(filePath)}`);
      setViewingFile({ path: filePath, content: r.content, truncated: r.truncated });
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, [archiveKey]);

  // 面包屑：useMemo 避免每次渲染重新计算
  const breadcrumbs = useMemo(() => currentPath ? currentPath.split('/').filter(Boolean) : [], [currentPath]);

  // 文件排序：目录优先，useMemo 避免对 file 数组重复排序
  const sortedFiles = useMemo(() => {
    const copy = [...files];
    copy.sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name));
    return copy;
  }, [files]);

  return <>
    <div className="modal-backdrop" onClick={onClose} />
    <div className="modal-panel archive-viewer-modal">
      {/* Header */}
      <header className="archive-viewer-header">
        <div className="archive-viewer-meta">
          <Icon name="folder" size={14} />
          <span className="archive-viewer-key" title={archiveKey}>{archiveKey.slice(0, 8)}</span>
          {archiveMeta && <>
            <span className="archive-viewer-sep">·</span>
            <span className="archive-viewer-size">{fmtSize(archiveMeta.sizeBytes)}</span>
            <span className="archive-viewer-sep">·</span>
            <span className="archive-viewer-time">{fmtTime(archiveMeta.createdAt)}</span>
          </>}
        </div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" size={16} /></button>
      </header>

      {/* Breadcrumb */}
      <div className="archive-viewer-crumbs">
        <button className="archive-viewer-crumb" onClick={() => navigateTo('')}>根目录</button>
        {breadcrumbs.map((seg, i) => (
          <span key={i} className="archive-viewer-crumb-wrap">
            <span className="archive-viewer-crumb-sep">/</span>
            <button className="archive-viewer-crumb" onClick={() => navigateTo(breadcrumbs.slice(0, i + 1).join('/'))}>{seg}</button>
          </span>
        ))}
        {!currentPath && !viewingFile && <span className="archive-viewer-crumb-current">/ 根目录</span>}
        {currentPath && !viewingFile && <span className="archive-viewer-crumb-current">/</span>}
      </div>

      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}

      {/* Body */}
      <div className="archive-viewer-body">
        {loading ? (
          <div className="archive-viewer-empty"><span className="spinner" /> 加载中…</div>
        ) : viewingFile ? (
          <div className="archive-viewer-file">
            <div className="archive-viewer-file-head">
              <button className="back-btn" onClick={() => setViewingFile(null)}><span className="archive-viewer-back-icon" aria-hidden="true">‹</span> 返回</button>
              <code>{viewingFile.path}</code>
              {viewingFile.truncated && <span className="truncated-badge">已截断</span>}
            </div>
            <pre className="archive-viewer-file-content"><code>{viewingFile.content}</code></pre>
          </div>
        ) : (
          <div className="archive-viewer-list">
            {/* 返回上级 */}
            {currentPath && (
              <button className="archive-viewer-item" onClick={() => navigateTo(currentPath.split('/').slice(0, -1).join('/'))}>
                <Icon name="folder" size={16} />
                <span className="archive-viewer-item-name">..</span>
                <span className="archive-viewer-item-mtime">—</span>
                <span className="archive-viewer-item-size">—</span>
              </button>
            )}
            {sortedFiles.length === 0 && !currentPath ? (
              <div className="archive-viewer-empty">此目录为空</div>
            ) : (
              sortedFiles.map(f => (
                <button
                  key={f.name}
                  className="archive-viewer-item"
                  onClick={() => f.type === 'directory' ? navigateTo(f.name) : viewFile(f.name)}
                >
                  <Icon name={f.type === 'directory' ? 'folder' : 'code'} size={16} />
                  <span className="archive-viewer-item-name">{f.name.split('/').pop()}</span>
                  <span className="archive-viewer-item-mtime">{fmtMtime(f.mtime)}</span>
                  <span className="archive-viewer-item-size">{f.type === 'directory' ? '—' : (f.size > 0 ? fmtSize(f.size) : '—')}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  </>;
}