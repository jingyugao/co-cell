import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../protocol/types';
import type { FileFavorite } from '../../../protocol/file-favorite-types.js';
import type { WorkspaceFilePreview } from '../../../protocol/workspace-types';
import { loadWorkspaceFile } from '../../lib/workspace-files';
import { api, errorMessage } from '../../lib/api';
import { fileContentUrl, fileViewUrl } from '../../lib/resource-links';
import Markdown, { type FileSelection } from '../chat/Markdown';
import { Icon } from '../../components/Icon';
import './WorkspaceFileView.css';

export type ProjectFileSelection = FileSelection & { projectId: string; workingDirectory: string };
const dateTime = (value: string) => Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  : '时间未知';

export function WorkspaceFileView({ file, onOpenFile, onClose }: {
  file: ProjectFileSelection; onOpenFile: (file: ProjectFileSelection) => void; onClose?: () => void;
}) {
  const fileKey = `${file.projectId}\0${file.path}`;
  const currentFileKey = useRef(fileKey);
  currentFileKey.current = fileKey;
  const [result, setResult] = useState<WorkspaceFilePreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [favoriteId, setFavoriteId] = useState<string | null>(null);
  const [favoriteLoaded, setFavoriteLoaded] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [favoriteError, setFavoriteError] = useState('');
  const [source, setSource] = useState(Boolean(file.line));
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(''); setLoading(true);
    void loadWorkspaceFile(file.projectId, file.path, controller.signal)
      .then(value => { if (!controller.signal.aborted) setResult(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); } });
    return () => { controller.abort(); };
  }, [file.projectId, file.path, retry]);
  useEffect(() => {
    const controller = new AbortController();
    setFavoriteId(null); setFavoriteLoaded(false); setFavoriteError('');
    void api<{ favorites: FileFavorite[] }>('/api/file-favorites', { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) {
          setFavoriteId(result.favorites.find(item => item.projectId === file.projectId && item.path === file.path)?.id ?? null);
          setFavoriteLoaded(true);
        }
      })
      .catch(reason => { if (!controller.signal.aborted) { setFavoriteError(`无法读取收藏状态：${errorMessage(reason)}`); setFavoriteLoaded(true); } });
    return () => controller.abort();
  }, [file.projectId, file.path]);
  useEffect(() => { setSource(Boolean(file.line)); }, [file.path, file.line]);
  useEffect(() => {
    if (!result) return;
    const target = file.line ? body.current?.querySelector(`[data-line="${file.line}"]`) : null;
    if (target) target.scrollIntoView({ block: 'center' });
    else if (file.fragment) {
      let fragment = file.fragment.replace(/^#/, '');
      try { fragment = decodeURIComponent(fragment); } catch { /* Keep literal fragment. */ }
      const target = [...(body.current?.querySelectorAll('[id]') ?? [])].find(node => node.id === fragment || node.id.endsWith(`-${fragment}`));
      target?.scrollIntoView({ block: 'start' });
    } else body.current?.scrollTo(0, 0);
  }, [result, file.line, file.fragment, source]);
  const markdown = /\.(?:md|markdown)$/i.test(file.path);
  const download = fileContentUrl(file.projectId, file.path) + '&download=1';
  async function toggleFavorite() {
    if (favoriteBusy || !favoriteLoaded) return;
    const requestFileKey = fileKey;
    const requestedFavoriteId = favoriteId;
    setFavoriteBusy(true); setFavoriteError('');
    try {
      if (requestedFavoriteId) {
        await api<{ ok: true }>(`/api/file-favorites/${encodeURIComponent(requestedFavoriteId)}`, { method: 'DELETE' });
        if (currentFileKey.current === requestFileKey) setFavoriteId(null);
      } else {
        const created = await api<FileFavorite>('/api/file-favorites', { method: 'POST', body: JSON.stringify({ projectId: file.projectId, path: file.path }) });
        if (currentFileKey.current === requestFileKey) setFavoriteId(created.id);
      }
      window.dispatchEvent(new Event('cocell:file-favorite-changed'));
    } catch (reason) {
      if (currentFileKey.current === requestFileKey) setFavoriteError(`收藏操作失败：${errorMessage(reason)}`);
    } finally { setFavoriteBusy(false); }
  }
  return <section className={`workspace-file-view ${onClose ? 'workspace-file-panel' : ''}`} aria-label="文件预览">
    <header className="workspace-file-header"><div><strong>{file.path.split('/').pop() || '文件预览'}</strong><span title={file.path}>{file.path}</span></div>
      {onClose && <button className="icon-button" onClick={onClose} aria-label="关闭文件预览"><Icon name="close" size={18} /></button>}
    </header>
    <div className="workspace-file-toolbar">
      <button className={`workspace-file-favorite${favoriteId ? ' selected' : ''}`} onClick={() => void toggleFavorite()} disabled={favoriteBusy || !favoriteLoaded} aria-pressed={Boolean(favoriteId)} title={favoriteId ? '取消收藏文件' : '收藏文件'}>
        <Icon name="bookmark" size={14} />{favoriteBusy ? '保存中…' : !favoriteLoaded ? '检查中…' : favoriteId ? '已收藏' : '收藏'}
      </button>
      {result?.kind === 'text' && markdown && <button onClick={() => setSource(value => !value)}>{source ? '阅读模式' : '查看源码'}</button>}
      <button onClick={() => setRetry(value => value + 1)} disabled={loading}>刷新</button>
      <a href={fileContentUrl(file.projectId, file.path)} target="_blank" rel="noopener noreferrer">浏览器查看 ↗</a>
      <a href={download} download={result?.name || file.path.split('/').pop()}>下载</a>
      {onClose && <a href={fileViewUrl(file.projectId, file.path, file.line, file.fragment)} target="_blank" rel="noopener noreferrer">独立打开 ↗</a>}
      {result && <span>{result.size.toLocaleString()} 字节 · {result.source === 'backup'
        ? `归档备份${result.backupCreatedAt ? ` · ${dateTime(result.backupCreatedAt)}` : ''}`
        : result.source === 'volume' ? '暂停环境文件' : '当前文件'}</span>}
    </div>
    {favoriteError && <div className="workspace-file-favorite-error" role="alert">{favoriteError}</div>}
    <div className="workspace-file-body" ref={body}>
      {loading && <p role="status"><span className="spinner" />正在读取文件，归档文件可能需要较长时间…</p>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {!loading && result?.kind === 'text' && result.truncated && <p role="status">仅预览前 1 MiB 内容，下载可查看完整文件。</p>}
      {!loading && result?.kind === 'image' && <img className="workspace-file-image" src={fileContentUrl(file.projectId, file.path)} alt={result.name} />}
      {!loading && result?.kind === 'text' && (markdown && !source
        ? <Markdown text={result.text ?? ''} projectId={file.projectId} workingDirectory={file.workingDirectory}
            baseDirectory={file.path.slice(0, file.path.lastIndexOf('/')) || '/'} onOpenFile={next => onOpenFile({ ...next, projectId: file.projectId, workingDirectory: file.workingDirectory })} />
        : <pre className="workspace-file-source">{(result.text ?? '').split('\n').map((line, index) => <div key={index} data-line={index + 1} className={file.line === index + 1 ? 'selected' : undefined}><span className="workspace-line-number" aria-hidden="true">{index + 1}</span><code>{line || '\n'}</code></div>)}</pre>)}
      {!loading && result?.kind === 'binary' && <p>该文件暂不支持页面内预览，可点击“浏览器查看”或下载查看。</p>}
    </div>
  </section>;
}

export default function WorkspaceFilePage({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');
  const readSelection = (): FileSelection => {
    const query = new URLSearchParams(window.location.search);
    const line = Number(query.get('line'));
    return { path: query.get('path') || '', ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}), fragment: window.location.hash };
  };
  const [selection, setSelection] = useState(readSelection);
  useEffect(() => {
    const controller = new AbortController();
    void api<Project>(`/api/projects/${encodeURIComponent(projectId)}`, { signal: controller.signal }).then(setProject)
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    const update = () => setSelection(readSelection());
    window.addEventListener('popstate', update); window.addEventListener('hashchange', update);
    return () => { controller.abort(); window.removeEventListener('popstate', update); window.removeEventListener('hashchange', update); };
  }, [projectId]);
  return <main className="workspace-file-page">
    <nav><a href={`/projects/${encodeURIComponent(projectId)}`}>← 返回项目</a><span>{project?.name || '项目文件'}</span></nav>
    {error ? <p role="alert">{error}</p> : !selection.path ? <p role="alert">链接缺少文件路径。</p> : project
      ? <WorkspaceFileView file={{ ...selection, projectId, workingDirectory: project.workingDirectory }} onOpenFile={next => {
          window.history.pushState(null, '', fileViewUrl(projectId, next.path, next.line, next.fragment)); setSelection(next);
        }} /> : <p role="status">正在读取项目…</p>}
  </main>;
}
