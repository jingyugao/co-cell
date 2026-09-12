import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../protocol/types';
import type { WorkspaceFile } from '../../../protocol/workspace-types';
import { api, errorMessage } from '../../lib/api';
import { fileContentUrl, fileViewUrl } from '../../lib/resource-links';
import Markdown, { type FileSelection } from '../chat/Markdown';
import { Icon } from '../../components/Icon';
import './WorkspaceFileView.css';

export type ProjectFileSelection = FileSelection & { projectId: string; workingDirectory: string };

export function WorkspaceFileView({ file, onOpenFile, onClose }: {
  file: ProjectFileSelection; onOpenFile: (file: ProjectFileSelection) => void; onClose?: () => void;
}) {
  const [result, setResult] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [source, setSource] = useState(Boolean(file.line));
  const [slow, setSlow] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(''); setLoading(true); setSlow(false);
    const timer = setTimeout(() => setSlow(true), 1500);
    void api<WorkspaceFile>(`/api/projects/${encodeURIComponent(file.projectId)}/files?path=${encodeURIComponent(file.path)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setResult(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); clearTimeout(timer); } });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [file.projectId, file.path, retry]);
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
  return <section className={`workspace-file-view ${onClose ? 'workspace-file-panel' : ''}`} aria-label="文件预览">
    <header className="workspace-file-header"><div><strong>{file.path.split('/').pop() || '文件预览'}</strong><span title={file.path}>{file.path}</span></div>
      {onClose && <button className="icon-button" onClick={onClose} aria-label="关闭文件预览"><Icon name="close" size={18} /></button>}
    </header>
    <div className="workspace-file-toolbar">
      {result?.kind === 'text' && markdown && <button onClick={() => setSource(value => !value)}>{source ? '阅读模式' : '查看源码'}</button>}
      <button onClick={() => setRetry(value => value + 1)} disabled={loading}>刷新</button>
      <a href={download} download={result?.name || file.path.split('/').pop()}>下载</a>
      {onClose && <a href={fileViewUrl(file.projectId, file.path, file.line, file.fragment)} target="_blank" rel="noopener noreferrer">独立打开 ↗</a>}
      {result && <span>{result.size.toLocaleString()} 字节 · 当前文件</span>}
    </div>
    <div className="workspace-file-body" ref={body}>
      {loading && <p role="status"><span className="spinner" />{slow ? '正在连接沙箱并读取文件；沙箱暂停时会自动恢复…' : '正在读取文件…'}</p>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {!loading && result?.kind === 'image' && <img className="workspace-file-image" src={fileContentUrl(file.projectId, file.path)} alt={result.name} />}
      {!loading && result?.kind === 'text' && (markdown && !source
        ? <Markdown text={result.text ?? ''} projectId={file.projectId} workingDirectory={file.workingDirectory}
            baseDirectory={file.path.slice(0, file.path.lastIndexOf('/')) || '/'} onOpenFile={next => onOpenFile({ ...next, projectId: file.projectId, workingDirectory: file.workingDirectory })} />
        : <pre className="workspace-file-source">{(result.text ?? '').split('\n').map((line, index) => <div key={index} data-line={index + 1} className={file.line === index + 1 ? 'selected' : undefined}><span className="workspace-line-number" aria-hidden="true">{index + 1}</span><code>{line || '\n'}</code></div>)}</pre>)}
      {!loading && result?.kind === 'binary' && <p>该文件暂不支持预览，请下载查看。</p>}
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
