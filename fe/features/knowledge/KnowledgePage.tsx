import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeCategory, KnowledgePage as KnowledgeDocument, KnowledgePagePrompt, KnowledgeSettings, KnowledgeView } from '../../../protocol/knowledge-types';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';
import Markdown from '../chat/Markdown';
import './KnowledgePage.css';

const categories: Array<{ id: KnowledgeCategory; label: string; description: string }> = [
  { id: 'business', label: '业务模块', description: '业务职责、规则、流程与关联系统' },
  { id: 'repositories', label: '代码仓库', description: '仓库用途、结构、入口与验证方式' },
  { id: 'components', label: '工具组件', description: '工具和组件的使用方式、限制与经验' },
  { id: 'workflows', label: '运营工作流', description: '任务触发、操作步骤、核验与异常处理' },
];
const promptLabel = Object.fromEntries(categories.map(item => [item.id, item.label])) as Record<KnowledgeCategory, string>;
const jobStatus: Record<KnowledgeView['jobs'][number]['status'], string> = {
  queued: '等待同步', syncing: '同步中', succeeded: '已同步', failed: '同步失败',
};
const pageStatus: Record<KnowledgeDocument['status'], string> = { pending: '等待生成', ready: '已生成', failed: '生成失败' };
const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';

export default function KnowledgePage({ onMenu, onBack, onDirtyChange }: {
  onMenu: () => void; onBack: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [edits, setEdits] = useState<Partial<Record<KnowledgeCategory, KnowledgePagePrompt>>>({});
  const [syncEdit, setSyncEdit] = useState<KnowledgeSettings | null>(null);
  const [selected, setSelected] = useState<KnowledgeCategory>('business');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingPage, setRefreshingPage] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestNumber = useRef(0);
  const dirty = Boolean(syncEdit) || Object.keys(edits).length > 0;
  const selectedPage = view?.pages.find(page => page.category === selected);
  const edit = edits[selected];

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);

  const refresh = useCallback(async (showLoading = false, discardEdits = false) => {
    const request = ++requestNumber.current;
    if (showLoading) setLoading(true);
    try {
      const result = await api<KnowledgeView>('/api/knowledge');
      if (request !== requestNumber.current) return;
      setView(result);
      if (discardEdits) setSyncEdit(null);
      setEdits(current => {
        const next = { ...current };
        for (const page of result.pages) {
          if (page.prompt && (discardEdits || current[page.category]?.text === page.prompt.text)) delete next[page.category];
        }
        return next;
      });
      if (showLoading) setError('');
    } catch (cause) {
      if (request === requestNumber.current) setError(errorMessage(cause));
    } finally {
      if (request === requestNumber.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { requestNumber.current++; window.clearInterval(timer); };
  }, [refresh]);

  function updatePrompt(text: string) {
    const prompt = selectedPage?.prompt;
    if (!prompt) return;
    setEdits(current => {
      const next = { ...current };
      if (text === prompt.text) delete next[selected];
      else next[selected] = { version: current[selected]?.version ?? prompt.version, text };
      return next;
    });
  }

  async function save() {
    if (!edit || saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const saved = await api<KnowledgePagePrompt>(`/api/knowledge/pages/${selected}/prompt`, { method: 'PUT', body: JSON.stringify(edit) });
      setEdits(current => { const next = { ...current }; delete next[selected]; return next; });
      setView(current => current && { ...current, pages: current.pages.map(page => page.category === selected ? { ...page, prompt: saved } : page) });
      setNotice(`“${promptLabel[selected]}”提示词已保存到 Hindsight。`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { await refresh(); setSaving(false); }
  }

  async function saveSync() {
    if (!syncEdit || saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const settings = await api<KnowledgeSettings>('/api/knowledge/settings', { method: 'PUT', body: JSON.stringify(syncEdit) });
      setView(current => current && { ...current, settings });
      setSyncEdit(null); setNotice('自动同步设置已保存。');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { await refresh(); setSaving(false); }
  }

  async function reloadSettings() {
    if (dirty && !window.confirm('重新加载会放弃尚未保存的修改，确定继续吗？')) return;
    await refresh(true, true);
  }

  async function retry(job: KnowledgeView['jobs'][number]) {
    if (retrying) return;
    setRetrying(job.id); setError(''); setNotice('');
    try {
      await api<{ ok: true }>(`/api/knowledge/jobs/${encodeURIComponent(job.id)}/retry`, {
        method: 'POST', body: JSON.stringify({ updatedAt: job.updatedAt }),
      });
      setNotice(`已重新提交“${job.projectName || job.sessionTitle || '对话'}”的记忆同步。`);
      await refresh(false);
    } catch (cause) { const message = errorMessage(cause); await refresh(false); setError(message); }
    finally { setRetrying(null); }
  }

  async function regeneratePage() {
    if (!view?.configured || !selectedPage?.prompt || edit || saving || refreshingPage) return;
    setRefreshingPage(true); setError(''); setNotice('');
    try {
      await api<{ ok: true }>(`/api/knowledge/pages/${encodeURIComponent(selected)}/refresh`, { method: 'POST' });
      setNotice(`已提交“${promptLabel[selected]}”知识页重新生成。`);
      await refresh(false);
    } catch (cause) { const message = errorMessage(cause); await refresh(false); setError(message); }
    finally { setRefreshingPage(false); }
  }

  return <main className="main-pane knowledge-page">
    <header className="topbar">
      <button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button>
      <div className="breadcrumbs"><span>系统管理</span><span className="slash">/</span><strong>知识库</strong></div>
      <div className="knowledge-top-actions">
        <button className="secondary-button" onClick={() => void reloadSettings()} disabled={loading || saving}>重新加载配置</button>
        <button className="secondary-button" onClick={() => void refresh(true)} disabled={loading}>刷新</button>
        <button className="secondary-button knowledge-chat-back" onClick={onBack}>返回对话</button>
      </div>
    </header>
    <div className="knowledge-scroll"><div className="knowledge-content">
      <section className="knowledge-heading">
        <div><span className="knowledge-eyebrow">COCELL · KNOWLEDGE</span><h1>知识库</h1><p>从对话材料中持续整理业务、代码仓库、工具组件和运营工作流知识。</p></div>

      </section>
      {error && <div className="knowledge-error" role="alert">{error}</div>}
      {notice && <div className="knowledge-notice" role="status">{notice}</div>}
      {!view && loading ? <div className="knowledge-state" role="status">正在加载知识库…</div> : !view ? <div className="knowledge-state">知识库暂时不可用。</div> : <>
        {!view.configured && <div className="knowledge-unconfigured" role="status"><strong>Hindsight 尚未配置</strong><span>请在服务端配置 HINDSIGHT_API_URL。配置完成后，这里会显示生成的知识页和同步状态。</span></div>}
        {view.error && <div className="knowledge-error" role="status">{view.error}</div>}
        <section className="knowledge-settings">
          <div className="knowledge-settings-heading"><div><h2>整理设置</h2><p>每页提示词由 Hindsight 保存。</p></div>
            <label className="knowledge-enable"><input type="checkbox" checked={syncEdit?.enabled ?? view.settings.enabled} disabled={saving || loading || (!view.configured && !view.settings.enabled)} onChange={event => setSyncEdit(event.target.checked === view.settings.enabled ? null : { ...view.settings, enabled: event.target.checked })} /><span>启用自动同步</span></label>
            {syncEdit && <button className="secondary-button" disabled={saving || loading} onClick={() => void saveSync()}>保存同步设置</button>}
          </div>
          <div className="knowledge-prompt-tabs" role="tablist" aria-label="知识类别">
            {categories.map(category => <button key={category.id} role="tab" aria-selected={selected === category.id} className={selected === category.id ? 'selected' : ''} onClick={() => setSelected(category.id)}>{category.label}</button>)}
          </div>
          <div className="knowledge-prompt-editor"><label htmlFor="knowledge-prompt">{promptLabel[selected]}整理提示词</label><textarea id="knowledge-prompt" value={edit?.text ?? selectedPage?.prompt?.text ?? ''} disabled={!selectedPage?.prompt || saving || loading} onChange={event => updatePrompt(event.target.value)} rows={7} /><small>{selectedPage?.prompt ? categories.find(item => item.id === selected)?.description : selectedPage?.error ?? (view.configured ? '尚未读取到本页提示词。' : '请先配置 Hindsight。')}</small>
            <div><button className="primary-button" onClick={() => void save()} disabled={!edit?.text.trim() || !selectedPage?.prompt || saving || loading}>保存本页提示词</button></div>
          </div>
        </section>
        <section className="knowledge-documents">
          <div className="knowledge-section-heading"><div><h2>生成的知识</h2><p>知识会从同步材料中持续归纳；过期状态表示有新材料尚未反映在当前页面。</p></div></div>
          <div className="knowledge-category-tabs" role="tablist" aria-label="知识页类别">
            {categories.map(category => {
              const page = view.pages.find(item => item.category === category.id);
              return <button key={category.id} role="tab" aria-selected={selected === category.id} className={selected === category.id ? 'selected' : ''} onClick={() => setSelected(category.id)}>
                <span>{category.label}</span><small className={`knowledge-page-status status-${page?.status ?? 'pending'}`}>{pageStatus[page?.status ?? 'pending']}</small>
              </button>;
            })}
          </div>
          <article className="knowledge-document">
            {selectedPage ? <>
              <header><div><span>{promptLabel[selected]}</span><h3>{selectedPage.name || promptLabel[selected]}</h3></div><div className="knowledge-document-actions"><div className="knowledge-document-meta"><span>{selectedPage.sourceCount} 份来源</span><span>{dateLabel(selectedPage.updatedAt)}</span><span className={`knowledge-page-status status-${selectedPage.status}`}>{pageStatus[selectedPage.status]}</span></div><button className="secondary-button" onClick={() => void regeneratePage()} disabled={!selectedPage.prompt || Boolean(edit) || saving || refreshingPage} title={edit ? '请先保存提示词修改' : !view.configured ? '请先配置 Hindsight' : undefined}>{refreshingPage ? '正在提交…' : '重新生成'}</button></div></header>
              {edit && <div className="knowledge-stale" role="status">请先保存提示词修改，再重新生成知识页。</div>}
              {selectedPage.isStale && <div className="knowledge-stale" role="status">新材料尚未合并到本页，稍后会继续更新。</div>}
              {selectedPage.error && <div className="knowledge-error" role="alert">{selectedPage.error}</div>}
              {selectedPage.status === 'ready' && selectedPage.body ? <Markdown text={selectedPage.body} /> : <div className="knowledge-state">{selectedPage.status === 'failed' ? '知识页生成失败，请点击“重新生成”重试。' : '还没有生成内容；同步对话材料后会自动生成。'}</div>}
            </> : <div className="knowledge-state">暂无此类别的知识页。</div>}
          </article>
        </section>
        <section className="knowledge-jobs">
          <div className="knowledge-section-heading"><div><h2>对话同步记录</h2><p>显示对话材料进入 Hindsight 的处理状态。</p></div></div>
          {!view.jobs.length ? <div className="knowledge-state">暂无待同步或已同步的对话。</div> : <div className="knowledge-job-list">
            {view.jobs.map(job => <article className="knowledge-job" key={job.id}>
              <div className="knowledge-job-source"><strong>{job.projectName || '未命名项目'}</strong><span>{job.sessionTitle || '未命名对话'}</span><small>对话更新于 {dateLabel(job.sourceUpdatedAt)} · {job.documentCount} 份材料 · 状态更新于 {dateLabel(job.updatedAt)}</small></div>
              <span className={`knowledge-job-status status-${job.status}`}>{jobStatus[job.status]}</span>
              {job.error && <span className="knowledge-job-error">{job.error}</span>}
              {job.status === 'failed' && <button className="secondary-button" disabled={retrying !== null} onClick={() => void retry(job)}>{retrying === job.id ? '正在重试…' : '重试同步'}</button>}
            </article>)}
          </div>}
        </section>
      </>}
    </div></div>
  </main>;
}
