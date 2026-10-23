import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemoryDetail, MemoryFile, MemoryFileContent, MemoryList, MemoryRecord } from '../../../protocol/memory-types';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';
import './MemoryPage.css';

const PAGE_SIZE = 50;
const statusLabel: Record<MemoryRecord['status'], string> = {
  queued: '等待整理', exporting: '准备材料', cleaning: '整理中', ready: '已整理', failed: '整理失败', skipped: '已跳过',
};
const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

async function loadMemoryList(offset: number, signal?: AbortSignal): Promise<MemoryList> {
  return api<MemoryList>(`/api/memory?offset=${offset}&limit=${PAGE_SIZE}`, { signal });
}

export default function MemoryPage({ onMenu, onBack }: { onMenu: () => void; onBack: () => void }) {
  const [items, setItems] = useState<MemoryRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [selectedFile, setSelectedFile] = useState<MemoryFile | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [totalBytes, setTotalBytes] = useState(0);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const detailSequence = useRef(0);
  const fileSequence = useRef(0);
  const listSequence = useRef(0);
  const moreSequence = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);
  const fileAbort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const detailOpen = Boolean(detail);

  const refreshList = useCallback(async (showLoading = false) => {
    const sequence = ++listSequence.current;
    moreSequence.current++; setMoreLoading(false);
    const controller = new AbortController();
    if (showLoading) { setListLoading(true); setListError(''); }
    try {
      const result = await loadMemoryList(0, controller.signal);
      if (sequence !== listSequence.current || !alive.current) return;
      setItems(result.items); setHasMore(result.hasMore); setOffset(result.items.length); setListError('');
    } catch (error) {
      if (sequence === listSequence.current && alive.current) setListError(errorMessage(error));
    } finally {
      if (sequence === listSequence.current && alive.current) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refreshList(true);
    return () => {
      alive.current = false; detailAbort.current?.abort(); fileAbort.current?.abort();
      detailSequence.current++; fileSequence.current++; listSequence.current++;
    };
  }, [refreshList]);
  useEffect(() => {
    if (detailOpen) return;
    const timer = window.setInterval(() => { if (offset <= PAGE_SIZE) void refreshList(false); }, 15_000);
    return () => window.clearInterval(timer);
  }, [detailOpen, offset, refreshList]);

  async function loadMore() {
    if (moreLoading || !hasMore) return;
    const sequence = ++moreSequence.current;
    setMoreLoading(true); setListError('');
    try {
      const result = await loadMemoryList(offset);
      if (sequence !== moreSequence.current || !alive.current) return;
      setItems(previous => [...previous, ...result.items.filter(item => !previous.some(existing => existing.id === item.id))]);
      setOffset(previous => previous + result.items.length); setHasMore(result.hasMore);
    } catch (error) { if (sequence === moreSequence.current && alive.current) setListError(errorMessage(error)); }
    finally { if (sequence === moreSequence.current && alive.current) setMoreLoading(false); }
  }

  async function fetchDetail(id: string, showLoading = true) {
    detailAbort.current?.abort();
    const controller = new AbortController(); detailAbort.current = controller;
    const sequence = ++detailSequence.current;
    if (showLoading) { setDetailLoading(true); setDetailError(''); }
    try {
      const result = await api<MemoryDetail>(`/api/memory/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (sequence !== detailSequence.current || !alive.current) return;
      setDetail(result);
      setSelectedFile(current => result.files.find(file => file.id === current?.id) ?? result.files[0] ?? null);
    } catch (error) {
      if (!controller.signal.aborted && sequence === detailSequence.current && alive.current) setDetailError(errorMessage(error));
    } finally {
      if (sequence === detailSequence.current && alive.current && showLoading) setDetailLoading(false);
    }
  }

  async function openRecord(record: MemoryRecord) {
    setDetail({ record, files: [] }); setSelectedFile(null); setFileContent(''); setFileError(''); setRetryError('');
    setNextOffset(null); setDetailLoading(true); setDetailError('');
    await fetchDetail(record.id);
  }

  const readContent = useCallback(async (file: MemoryFile, offsetBytes: number, append: boolean) => {
    fileAbort.current?.abort();
    const controller = new AbortController(); fileAbort.current = controller;
    const sequence = ++fileSequence.current;
    setFileLoading(true); setFileError('');
    try {
      const result = await api<MemoryFileContent>(`/api/memory/${encodeURIComponent(detail!.record.id)}/files/${encodeURIComponent(file.id)}?offset=${offsetBytes}`, { signal: controller.signal });
      if (sequence !== fileSequence.current || !alive.current) return;
      setFileContent(current => append ? current + result.content : result.content);
      setNextOffset(result.nextOffset); setTotalBytes(result.totalBytes);
    } catch (error) {
      if (!controller.signal.aborted && sequence === fileSequence.current && alive.current) setFileError(errorMessage(error));
    } finally { if (sequence === fileSequence.current && alive.current) setFileLoading(false); }
  }, [detail]);

  useEffect(() => {
    if (!detail || !selectedFile) { fileAbort.current?.abort(); fileSequence.current++; setFileContent(''); setNextOffset(null); setTotalBytes(0); return; }
    setFileContent(''); setNextOffset(null); setTotalBytes(0); setFileError('');
    void readContent(selectedFile, 0, false);
    return () => { fileAbort.current?.abort(); fileSequence.current++; };
  }, [detail?.record.id, selectedFile?.id, readContent]);

  async function retry() {
    if (!detail || detail.record.status !== 'failed' || retrying) return;
    setRetrying(true); setRetryError('');
    try {
      await api<{ ok: true }>(`/api/memory/${encodeURIComponent(detail.record.id)}/retry`, {
        method: 'POST', body: JSON.stringify({ updatedAt: detail.record.updatedAt }),
      });
      await Promise.all([fetchDetail(detail.record.id, false), refreshList(false)]);
    } catch (error) {
      setRetryError(errorMessage(error));
      void fetchDetail(detail.record.id, false);
      void refreshList(false);
    }
    finally { setRetrying(false); }
  }

  function closeDetail() {
    detailAbort.current?.abort(); fileAbort.current?.abort();
    detailSequence.current++; fileSequence.current++;
    setDetail(null); setDetailError(''); setSelectedFile(null); setFileContent(''); setFileError(''); setRetryError('');
  }

  return <main className="main-pane memory-page">
    <header className="topbar">
      <button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button>
      <div className="breadcrumbs"><span>系统管理</span><span className="slash">/</span><strong>记忆</strong></div>
      <div className="memory-top-actions">
        {detail ? <><button className="secondary-button" onClick={() => void fetchDetail(detail.record.id)} disabled={detailLoading}>刷新详情</button><button className="secondary-button" onClick={closeDetail}>返回列表</button></> : <button className="secondary-button" onClick={() => void refreshList(true)} disabled={listLoading}>刷新</button>}
        <button className="secondary-button memory-chat-back" onClick={onBack}>返回对话</button>
      </div>
    </header>
    <div className="memory-content">
      {!detail ? <>
        <div className="memory-heading"><div><span className="memory-eyebrow">COCELL · MEMORY</span><h1>记忆</h1><p>对话超过 24 小时未更新且环境已暂停后，会自动整理为可查看的资料。系统项目不会生成记忆。</p></div><button className="secondary-button memory-refresh-mobile" onClick={() => void refreshList(true)} disabled={listLoading}>刷新</button></div>
        {listError && <div className="memory-error" role="alert"><span>{listError}</span><button className="secondary-button" onClick={() => void refreshList(true)}>重试</button></div>}
        {listLoading && !items.length ? <div className="memory-state" role="status">正在加载记忆…</div> : !items.length ? <div className="memory-state">暂无记忆</div> : <div className="memory-list" aria-busy={listLoading}>
          <div className="memory-list-heading"><span>对话</span><span>更新时间</span><span>整理时间</span><span>文件</span><span>状态</span></div>
          {items.map(item => <article key={item.id} className="memory-row">
            <button className="memory-record-link" onClick={() => void openRecord(item)}>
              <strong>{item.projectName}</strong><span className="memory-first-message">{item.firstMessage.trim() || item.sessionTitle || '未命名对话'}</span>
              <small>{item.sessionTitle}</small>
            </button>
            <time dateTime={item.sourceUpdatedAt}>{dateLabel(item.sourceUpdatedAt)}</time>
            <time dateTime={item.cleanedAt}>{dateLabel(item.cleanedAt)}</time>
            <span className="memory-file-count">{item.fileCount} 个{item.encryptedCount > 0 && <small className="memory-encrypted-note">{item.encryptedCount} 处内容无法还原</small>}</span>
            <span className={`memory-status status-${item.status}`}>{statusLabel[item.status]}</span>
          </article>)}
        </div>}
        {hasMore && <div className="memory-load-more"><button className="secondary-button" onClick={() => void loadMore()} disabled={moreLoading}>{moreLoading ? '加载中…' : '加载更多'}</button></div>}
      </> : <>
        <div className="memory-detail-heading"><button className="memory-back-inline" onClick={closeDetail}>← 返回记忆列表</button><span className="memory-eyebrow">对话记忆</span><h1>{detail.record.projectName}</h1><p>{detail.record.firstMessage.trim() || detail.record.sessionTitle || '未命名对话'}</p></div>
        <div className="memory-detail-meta"><span>对话更新时间 <time>{dateLabel(detail.record.sourceUpdatedAt)}</time></span><span>整理时间 <time>{dateLabel(detail.record.cleanedAt)}</time></span><span className={`memory-status status-${detail.record.status}`}>{statusLabel[detail.record.status]}</span><span>{detail.record.fileCount} 个文件</span></div>
        {detail.record.error && <div className="memory-error" role="alert">{detail.record.error}</div>}
        {detail.record.status === 'failed' && <div className="memory-retry-row"><span>可以重新尝试整理这条记忆。</span><button className="primary-button" onClick={() => void retry()} disabled={retrying}>{retrying ? '正在重试…' : '重试'}</button></div>}
        {retryError && <div className="memory-error" role="alert">{retryError}</div>}
        {detailError && <div className="memory-error" role="alert"><span>{detailError}</span><button className="secondary-button" onClick={() => void fetchDetail(detail.record.id)}>重试读取</button></div>}
        {detailLoading ? <div className="memory-state" role="status">正在加载详情…</div> : <div className="memory-detail-layout">
          <nav className="memory-file-list" aria-label="记忆文件">
            <strong>文件 <span>{detail.files.length}</span></strong>
            {!detail.files.length ? <p>暂时没有可查看的文件。</p> : detail.files.map(file => <button key={file.id} className={selectedFile?.id === file.id ? 'selected' : ''} onClick={() => setSelectedFile(file)}><span>{file.path}</span><small>{sizeLabel(file.byteLength)} · {file.agentName}</small></button>)}
          </nav>
          <section className="memory-file-viewer">
            {selectedFile ? <>
              <div className="memory-file-heading"><div><span>正在查看</span><h2 title={selectedFile.path}>{selectedFile.path}</h2></div><small>{sizeLabel(totalBytes || selectedFile.byteLength)}</small></div>
              {fileError && <div className="memory-error" role="alert"><span>{fileError}</span><button className="secondary-button" onClick={() => void readContent(selectedFile, 0, false)}>重试读取</button></div>}
              <pre className="memory-file-content" aria-label={`${selectedFile.path} 文件内容`} aria-busy={fileLoading}>{fileLoading && !fileContent ? '正在读取文件…' : fileContent}</pre>
              <div className="memory-file-footer"><span>{fileContent.length ? `${new TextEncoder().encode(fileContent).byteLength.toLocaleString()} / ${totalBytes.toLocaleString()} 字节已读取` : `${sizeLabel(totalBytes || selectedFile.byteLength)}`}</span>{nextOffset !== null && <button className="secondary-button" disabled={fileLoading} onClick={() => void readContent(selectedFile, nextOffset, true)}>{fileLoading ? '加载中…' : '加载更多'}</button>}</div>
            </> : <div className="memory-state">选择一个文件查看内容</div>}
          </section>
        </div>}
      </>}
    </div>
  </main>;
}
