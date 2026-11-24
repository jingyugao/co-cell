import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgePage as KnowledgeDocument, KnowledgePagePrompt, KnowledgeTreeNode, KnowledgeView } from '../../../protocol/knowledge-types';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';
import Markdown from '../chat/Markdown';
import './KnowledgePage.css';

const pageStatus: Record<KnowledgeDocument['status'], string> = { pending: '等待生成', ready: '已生成', failed: '生成失败' };
const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';

function PageDirectory({ nodes, selectedId, onSelect }: {
  nodes: KnowledgeTreeNode[]; selectedId?: string; onSelect: (id: string) => void;
}) {
  return <ul>{nodes.map(node => <li key={node.id}>
    {node.kind === 'folder' ? <details open>
      <summary>{node.name}</summary>
      <PageDirectory nodes={node.children} selectedId={selectedId} onSelect={onSelect} />
    </details> : <button type="button" aria-current={node.id === selectedId ? 'page' : undefined} onClick={() => onSelect(node.id)}>
      {node.name}
    </button>}
  </li>)}</ul>;
}

export default function KnowledgePage({ onMenu, onBack, onDirtyChange }: {
  onMenu: () => void; onBack: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [edits, setEdits] = useState<Partial<Record<string, KnowledgePagePrompt>>>({});
  const requestedPage = useRef<string | undefined>(undefined);
  const fetching = useRef(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingPage, setRefreshingPage] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestNumber = useRef(0);
  const dirty = Object.keys(edits).length > 0;
  const selectedPage = view?.selectedPage;
  const edit = selectedPage && edits[selectedPage.id];

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);

  const refresh = useCallback(async (showLoading = false, discardEdits = false) => {
    const request = ++requestNumber.current;
    fetching.current = true;
    if (showLoading) setLoading(true);
    try {
      const query = requestedPage.current ? `?pageId=${encodeURIComponent(requestedPage.current)}` : '';
      const result = await api<KnowledgeView>(`/api/knowledge${query}`);
      if (request !== requestNumber.current) return;
      const page = result.selectedPage;
      if (page || !result.error) requestedPage.current = page?.id;
      setView(result);
      if (discardEdits) setEdits({});
      else if (page?.prompt) setEdits(current => {
        if (current[page.id]?.text !== page.prompt?.text) return current;
        const next = { ...current };
        delete next[page.id];
        return next;
      });
      if (showLoading) setError('');
    } catch (cause) {
      if (request === requestNumber.current) setError(errorMessage(cause));
    } finally {
      if (request === requestNumber.current) { fetching.current = false; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => { if (!fetching.current) void refresh(); }, 15_000);
    return () => { requestNumber.current++; window.clearInterval(timer); };
  }, [refresh]);

  function selectPage(id: string) {
    requestedPage.current = id;
    setError(''); setNotice('');
    void refresh(true);
  }

  function updatePrompt(text: string) {
    const prompt = selectedPage?.prompt;
    if (!selectedPage || !prompt) return;
    const selected = selectedPage.id;
    setEdits(current => {
      const next = { ...current };
      if (text === prompt.text) delete next[selected];
      else next[selected] = { version: current[selected]?.version ?? prompt.version, text };
      return next;
    });
  }

  async function save() {
    if (!selectedPage || !edit || saving) return;
    const selected = selectedPage.id;
    setSaving(true); setError(''); setNotice('');
    try {
      const saved = await api<KnowledgePagePrompt>(`/api/knowledge/pages/${encodeURIComponent(selected)}/prompt`, { method: 'PUT', body: JSON.stringify(edit) });
      setEdits(current => { const next = { ...current }; delete next[selected]; return next; });
      setView(current => current?.selectedPage?.id === selected ? { ...current, selectedPage: { ...current.selectedPage, prompt: saved } } : current);
      setNotice(`“${selectedPage.name}”提示词已保存到 Hindsight。`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { await refresh(); setSaving(false); }
  }

  async function reloadSettings() {
    if (dirty && !window.confirm('重新加载会放弃尚未保存的修改，确定继续吗？')) return;
    await refresh(true, true);
  }

  async function regeneratePage() {
    if (!view?.configured || !selectedPage?.prompt || edit || saving || refreshingPage) return;
    setRefreshingPage(true); setError(''); setNotice('');
    try {
      await api<{ ok: true }>(`/api/knowledge/pages/${encodeURIComponent(selectedPage.id)}/refresh`, { method: 'POST' });
      setNotice(`已提交“${selectedPage.name}”知识页重新生成。`);
      await refresh(false);
    } catch (cause) { const message = errorMessage(cause); await refresh(false); setError(message); }
    finally { setRefreshingPage(false); }
  }

  return <main className="main-pane knowledge-page">
    <header className="topbar">
      <button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button>
      <div className="breadcrumbs"><span>系统管理</span><span className="slash">/</span><strong>知识库</strong></div>
      <div className="knowledge-top-actions">
        {dirty && <button className="secondary-button" onClick={() => void reloadSettings()} disabled={loading || saving}>放弃修改</button>}
        <button className="secondary-button" onClick={() => void refresh(true)} disabled={loading}>刷新</button>
        <button className="secondary-button knowledge-chat-back" onClick={onBack}>返回对话</button>
      </div>
    </header>
    <div className="knowledge-scroll"><div className="knowledge-content">
      <section className="knowledge-heading">
        <h1>知识库</h1>
        {view && <span className="knowledge-enable">{view.bankId && <>共享 bank · {view.bankId}　</>}会话投递已{view.settings.enabled ? '启用' : '关闭'}</span>}
      </section>
      {error && <div className="knowledge-error" role="alert">{error}</div>}
      {notice && <div className="knowledge-notice" role="status">{notice}</div>}
      {!view && loading ? <div className="knowledge-state" role="status">正在加载知识库…</div> : !view ? <div className="knowledge-state">知识库暂时不可用。</div> : <>
        {!view.configured && <div className="knowledge-unconfigured" role="status"><strong>Hindsight 尚未配置</strong><span>请在服务端配置 HINDSIGHT_API_URL。配置完成后，这里会显示该 bank 的知识页。</span></div>}
        {view.error && <div className="knowledge-error" role="status">{view.error}</div>}
        {view.configured && <section className="knowledge-documents">
          {view.pages.length > 0 ? <div className="knowledge-browser">
            <nav className="knowledge-directory" aria-label="Hindsight 知识页目录">
              <h2>页面目录</h2>
              <PageDirectory nodes={view.pages} selectedId={selectedPage?.id} onSelect={selectPage} />
            </nav>
            <article className="knowledge-document" aria-busy={loading}>
              {selectedPage ? <>
                <header><div><h3>{selectedPage.name}</h3></div><div className="knowledge-document-actions">
                  <div className="knowledge-document-meta">
                    {selectedPage.prompt && <span>{selectedPage.sourceCount} 份来源</span>}
                    {selectedPage.updatedAt && <span>{dateLabel(selectedPage.updatedAt)}</span>}
                    <span className={`knowledge-page-status status-${selectedPage.status}`}>{pageStatus[selectedPage.status]}</span>
                  </div>
                  <button className="secondary-button" onClick={() => void regeneratePage()} disabled={!selectedPage.prompt || Boolean(edit) || saving || refreshingPage || loading}>{refreshingPage ? '正在提交…' : '重新生成'}</button>
                </div></header>
                {selectedPage.isStale && <div className="knowledge-stale" role="status">有新材料可用于更新本页。</div>}
                {selectedPage.error && <div className="knowledge-error" role="alert">{selectedPage.error}</div>}
                {selectedPage.body ? <Markdown text={selectedPage.body} /> : <div className="knowledge-state">暂无已生成的内容。</div>}
                {selectedPage.prompt && <details key={selectedPage.id} className="knowledge-prompt">
                  <summary>整理提示词</summary>
                  <div className="knowledge-prompt-editor">
                    <label htmlFor="knowledge-prompt">{selectedPage.name}整理提示词</label>
                    <textarea id="knowledge-prompt" value={edit?.text ?? selectedPage.prompt.text} disabled={saving || loading} onChange={event => updatePrompt(event.target.value)} rows={7} />
                    {edit && <small>保存提示词后可重新生成本页。</small>}
                    <div><button className="primary-button" onClick={() => void save()} disabled={!edit?.text.trim() || saving || loading}>保存本页提示词</button></div>
                  </div>
                </details>}
              </> : <div className="knowledge-state">目录中暂无知识页。</div>}
            </article>
          </div> : !view.error && <div className="knowledge-state">Hindsight 知识库中暂无页面。</div>}
        </section>}
      </>}
    </div></div>
  </main>;
}
