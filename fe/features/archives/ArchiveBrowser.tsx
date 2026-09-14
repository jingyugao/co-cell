import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import './ArchiveBrowser.css';

type ArchiveEntry = { key: string; size: number; createdAt: string };
type ProjectArchive = { projectId: string; projectName: string; latestAt: string; count: number; archives: ArchiveEntry[] };
type FileEntry = { name: string; type: 'file' | 'directory'; size: number };

function fmtSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtTime(ts: string) {
  try { return new Date(ts).toLocaleString('zh-CN'); } catch { return ts; }
}

export default function ArchiveBrowser({ onBack }: { onBack: () => void }) {
  const [projects, setProjects] = useState<ProjectArchive[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [selectedArchive, setSelectedArchive] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<{ path: string; content: string; truncated: boolean } | null>(null);

  useEffect(() => {
    api<ProjectArchive[]>('/api/archives').then(setProjects).catch(e => setError(errorMessage(e))).finally(() => setLoading(false));
  }, []);

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
        {files.map(f => <button key={f.name} className="ab-file-row" onClick={() => f.type === 'directory' ? navigateTo(`${currentPath ? currentPath + '/' : ''}${f.name}`) : viewFile(`${currentPath ? currentPath + '/' : ''}${f.name}`)}><span className="ab-file-icon">{f.type === 'directory' ? '📁' : '📄'}</span><span className="ab-file-name">{f.name.split('/').pop()}</span></button>)}
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
        <span className="ab-project-meta">{p.count} 个归档 · 最新 {fmtTime(p.latestAt)}</span>
      </button>)}
      {projects.length === 0 && <p className="empty-hint">暂无归档记录</p>}
    </div>}
  </div>;
}