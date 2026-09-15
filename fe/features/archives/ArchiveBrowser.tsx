import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import './ArchiveBrowser.css';

type ArchiveEntry = { key: string; size: number; createdAt: string };
type ProjectArchive = { projectId: string; projectName: string; latestAt: string; count: number; archives: ArchiveEntry[] };
type FileEntry = { name: string; type: 'file' | 'directory'; size: number };

function fmtSize(bytes: number) {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function totalSize(archives: ArchiveEntry[]) {
  return archives.reduce((s, a) => s + a.size, 0);
}

function fmtTime(ts: string) {
  try { return new Date(ts).toLocaleString('zh-CN'); } catch { return ts; }
}

function parseHashParams(): { archive: string | null; path: string } {
  try {
    const raw = window.location.hash.slice(1);
    const q = raw.indexOf('?');
    if (q < 0) return { archive: null, path: '' };
    const params = new URLSearchParams(raw.slice(q + 1));
    return { archive: params.get('archive'), path: params.get('path') || '' };
  } catch { return { archive: null, path: '' }; }
}

function syncHash(archive: string | null, path: string) {
  const p = new URLSearchParams();
  if (archive) p.set('archive', archive);
  if (path) p.set('path', path);
  const qs = p.toString();
  const hash = 'archives' + (qs ? '?' + qs : '');
  const url = window.location.pathname + window.location.search + '#' + hash;
  if (window.location.hash !== '#' + hash) {
    window.history.replaceState(null, '', url);
  }
}

export default function ArchiveBrowser({ onBack }: { onBack: () => void }) {
  const initialParams = useRef(parseHashParams());
  const [projects, setProjects] = useState<ProjectArchive[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(initialParams.current.path);
  const [selectedArchive, setSelectedArchive] = useState<string | null>(initialParams.current.archive);
  const [viewingFile, setViewingFile] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const restored = useRef(false);

  useEffect(() => {
    api<ProjectArchive[]>('/api/archives').then(setProjects).catch(e => setError(errorMessage(e))).finally(() => setLoading(false));
  }, []);

  // Restore archive browsing state from URL on mount
  useEffect(() => {
    if (restored.current) return;
    const { archive, path } = initialParams.current;
    if (!archive) return;
    restored.current = true;
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    api<{ entries: FileEntry[] }>(`/api/archives/${archive}/files${query}`)
      .then(r => setFiles(r.entries))
      .catch(e => setError(errorMessage(e)));
  }, []);

  // Sync archive/path back to URL hash whenever they change
  useEffect(() => {
    syncHash(selectedArchive, currentPath);
  }, [selectedArchive, currentPath]);

  const grandTotal = projects.reduce((s, p) => s + totalSize(p.archives), 0);
  const totalCount = projects.reduce((s, p) => s + p.count, 0);

  async function browseArchive(archiveKey: string) {
    setSelectedArchive(archiveKey);
    setCurrentPath('');
    setViewingFile(null);
    try { setFiles((await api<{ entries: FileEntry[] }>(`/api/archives/${archiveKey}/files`)).entries); }
    catch (e) { setError(errorMessage(e)); }
  }

  async function navigateTo(path: string) {
    if (!selectedArchive) return;
    setCurrentPath(path);
    try { setFiles((await api<{ entries: FileEntry[] }>(`/api/archives/${selectedArchive}/files?path=${encodeURIComponent(path)}`)).entries); }
    catch (e) { setError(errorMessage(e)); }
  }

  async function viewFile(filePath: string) {
    if (!selectedArchive) return;
    try {
      const result = await api<{ content: string; truncated: boolean }>(`/api/archives/${selectedArchive}/file?path=${encodeURIComponent(filePath)}`);
      setViewingFile({ path: filePath, content: result.content, truncated: result.truncated });
    } catch (e) { setError(errorMessage(e)); }
  }

  function goBack() {
    if (viewingFile) { setViewingFile(null); return; }
    if (selectedArchive) {
      if (currentPath) {
        const parent = currentPath.split('/').slice(0, -1).join('/');
        navigateTo(parent);
      } else {
        setSelectedArchive(null);
        setFiles([]);
        setSelectedProject(null);
      }
    }
  }

  const project = projects.find(p => p.projectId === selectedProject);

  return <div className="archive-browser">
    <header className="ab-header">
      <button className="back-btn" onClick={selectedArchive ? goBack : onBack}>← {selectedArchive ? '返回' : '返回'}</button>
      <h2>Sandbox 归档管理</h2>
      {!loading && !selectedArchive && projects.length > 0 && <span className="ab-total-size">{fmtSize(grandTotal)} / {totalCount} 个归档</span>}
    </header>
    {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}

    {loading ? <p className="empty-hint">加载中...</p> :
     selectedArchive ? <>
      <div className="ab-breadcrumb">
        <button onClick={() => { setSelectedArchive(null); setSelectedProject(null); setFiles([]); }}>归档列表</button>
        <span> / </span>
        <strong>{selectedArchive}</strong>
        {currentPath && <><span> / </span><span>{currentPath}</span></>}
      </div>
      {viewingFile ? <div className="ab-file-viewer">
        <div className="ab-file-header">{viewingFile.path} {viewingFile.truncated && <span className="truncated-badge">已截断</span>}</div>
        <pre className="ab-file-content"><code>{viewingFile.content}</code></pre>
      </div> : <div className="ab-file-list">
        {currentPath && <button className="ab-file-row" onClick={() => navigateTo(currentPath.split('/').slice(0, -1).join('/'))}><span className="ab-file-icon">📁</span><span>..</span></button>}
        {files.map(f => <button key={f.name} className="ab-file-row" onClick={() => f.type === 'directory' ? navigateTo(f.name) : viewFile(f.name)}><span className="ab-file-icon">{f.type === 'directory' ? '📁' : '📄'}</span><span className="ab-file-name">{f.name.split('/').pop()}</span></button>)}
      </div>}
    </> : selectedProject && project ? <>
      <div className="ab-breadcrumb">
        <button onClick={() => setSelectedProject(null)}>项目列表</button>
        <span> / </span>
        <strong>{project.projectName}</strong>
      </div>
      <div className="ab-archive-list">
        {project.archives.map(a => <button key={a.key} className="ab-archive-row" onClick={() => browseArchive(a.key)}>
          <span className="ab-archive-key">{a.key}</span>
          <span className="ab-archive-meta">{fmtSize(a.size)} · {fmtTime(a.createdAt)}</span>
        </button>)}
      </div>
    </> : <div className="ab-project-list">
      {projects.map(p => <button key={p.projectId} className="ab-project-row" onClick={() => setSelectedProject(p.projectId)}>
        <span className="ab-project-name">{p.projectName}</span>
        <span className="ab-project-meta">{fmtSize(totalSize(p.archives))} · {p.count} 个归档 · 最新 {fmtTime(p.latestAt)}</span>
      </button>)}
      {projects.length === 0 && <p className="empty-hint">暂无归档记录</p>}
    </div>}
  </div>;
}