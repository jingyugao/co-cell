import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCredentialEntry, ToolCredentialFile, ToolCredentialTree } from '../../../protocol/tool-credential-types';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useDraftStatus } from './DraftGuard';
import './ToolCredentialBrowser.css';

type Props = { tool: string; onClose?: () => void; embedded?: boolean };
const fileUrl = (tool: string, path: string) => `/api/tools/${encodeURIComponent(tool)}/credentials/file?path=${encodeURIComponent(path)}`;

export default function ToolCredentialBrowser({ tool, onClose, embedded = false }: Props) {
  const [tree, setTree] = useState<ToolCredentialTree | null>(null);
  const [selected, setSelected] = useState<ToolCredentialFile | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const treeRequest = useRef<AbortController | null>(null);
  const fileRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const dirty = selected !== null && draft !== selected.content;
  const draftGuard = useDraftStatus('credential-browser', dirty, busy);

  async function refresh() {
    treeRequest.current?.abort();
    const controller = new AbortController();
    treeRequest.current = controller;
    setError(''); setMessage('');
    try {
      const value = await api<ToolCredentialTree>(`/api/tools/${encodeURIComponent(tool)}/credentials`, { signal: controller.signal });
      if (!controller.signal.aborted) setTree(value);
    } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }

  useEffect(() => {
    setTree(null); setSelected(null); setDraft(''); setLoading(true); setError(''); setMessage('');
    void refresh();
    return () => {
      generation.current++;
      treeRequest.current?.abort(); fileRequest.current?.abort(); saveRequest.current?.abort();
    };
  }, [tool]);

  const entries = useMemo(() => [...(tree?.entries ?? [])].sort((a, b) => a.path.localeCompare(b.path)), [tree]);
  function select(entry: ToolCredentialEntry) {
    if (entry.type !== 'file') return;
    if (dirty && !window.confirm('当前文件有未保存的修改。放弃修改并打开另一个文件吗？')) return;
    fileRequest.current?.abort();
    const controller = new AbortController();
    fileRequest.current = controller;
    const requestId = ++generation.current;
    setSelected(null); setDraft(''); setError(''); setMessage(''); setBusy(true);
    void api<ToolCredentialFile>(fileUrl(tool, entry.path), { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || requestId !== generation.current) return;
      setSelected(value); setDraft(value.content);
    }).catch(err => { if (!controller.signal.aborted && requestId === generation.current) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted && requestId === generation.current) setBusy(false); });
  }

  async function save() {
    if (!selected) return;
    setBusy(true); setError(''); setMessage('');
    saveRequest.current?.abort();
    const controller = new AbortController();
    saveRequest.current = controller;
    try {
      const saved = await api<ToolCredentialFile>(fileUrl(tool, selected.path), {
        method: 'PUT',
        body: JSON.stringify({ path: selected.path, content: draft, encoding: selected.encoding, version: selected.version, scriptVersion: selected.scriptVersion }),
        signal: controller.signal,
      });
      setSelected(saved); setDraft(saved.content);
      window.dispatchEvent(new Event('cocell:tool-catalog-changed'));
      await refresh();
      setMessage('凭据文件已保存。');
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && err.status === 409) setError('文件或 hook 已更新。当前草稿已保留；刷新目录后重新打开文件以读取最新版本。');
      else setError(errorMessage(err));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  function close() {
    if (busy) return;
    if (dirty && !window.confirm('当前文件有未保存的修改。关闭后将丢弃这些修改，继续吗？')) return;
    fileRequest.current?.abort(); setSelected(null); setDraft(''); draftGuard?.clear('credential-browser'); onClose?.();
  }

  return <section className="tool-credential-browser" aria-label={`${tool} 凭据文件`}>
    <header className="tool-credential-browser-heading"><div><h3>{tool} · 凭据</h3><p>共享目录 {tree?.home ?? '读取中…'}</p></div>
      <div><button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}>刷新</button>{!embedded && <button type="button" className="secondary-button" disabled={busy} onClick={close}>关闭</button>}</div></header>
    {error && <p className="connections-error" role="alert">{error}</p>}{message && <p className="connections-message" role="status">{message}</p>}
    <div className="tool-credential-layout">
      <div className="tool-credential-tree" aria-label="凭据目录树">
        <strong>文件</strong>
        {loading ? <p role="status">正在读取目录…</p> : entries.length ? <ul>{entries.map(entry => <li key={entry.path} className={`is-${entry.type}`}>
          <button type="button" disabled={busy || entry.type !== 'file'} aria-current={selected?.path === entry.path ? 'page' : undefined}
            title={entry.path} style={{ paddingLeft: `${Math.min(entry.path.split('/').length - 1, 8) * 12 + 3}px` }} onClick={() => select(entry)}><span>{entry.type === 'directory' ? '▸ ' : '· '}</span><code>{entry.path}</code></button>
        </li>)}</ul> : <p>没有配置凭据路径。</p>}
      </div>
      <div className="tool-credential-file">
        {!selected ? <p>{busy ? '正在读取文件…' : '点击文件查看或编辑内容。文件内容只会在选择后读取。'}</p> : <>
          <div className="tool-credential-file-heading"><strong title={selected.path}>{selected.path}</strong><span>{selected.encoding} · {selected.size} bytes</span></div>
          {selected.names?.length ? <p className="tool-credential-names">连接名称：{selected.names.join('、')}</p> : null}
          {selected.editable ? <textarea aria-label={`${selected.path} 文件内容`} spellCheck={false} autoComplete="off" value={draft} onChange={event => setDraft(event.target.value)} />
            : <pre>{draft}</pre>}
          <div className="tool-credential-file-actions"><button type="button" className="primary-button" disabled={busy || !selected.editable || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存文件'}</button>
            {dirty && <span>有未保存的修改</span>}</div>
        </>}
      </div>
    </div>
  </section>;
}
