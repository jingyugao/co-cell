import { useEffect, useState } from 'react';
import type { ImprovementPage, ImprovementProposal } from '../../../shared/improvement-types';
import { Icon } from '../../components/Icon';
import { api, errorMessage } from '../../lib/api';
import './ImprovementsPage.css';

type Props = {
  onMenu: () => void;
  onBack: () => void;
  onOpenSession: (id: string) => Promise<void>;
};
const pageSize = 30;
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';

function ProposalCard({ item, onOpenSession }: { item: ImprovementProposal; onOpenSession: Props['onOpenSession'] }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  return <details className="improvement-card">
    <summary>
      <div className="improvement-title"><h2>{item.title}</h2><span className="improvement-pending">待处理</span><Icon name="chevron" size={16} /></div>
      <div className="improvement-meta"><span className="improvement-category">{item.category}</span><span>{item.projectName || '未关联项目'}</span><time dateTime={item.createdAt}>{date(item.createdAt)}</time></div>
    </summary>
    <div className="improvement-details">
      <section><h3>发现与依据</h3><p>{item.observation}</p></section>
      <section><h3>改进建议</h3><p>{item.proposal}</p></section>
      <section><h3>预期收益</h3><p>{item.expected_benefit}</p></section>
      <section className="improvement-source"><h3>建议来源</h3>
        <dl><div><dt>项目</dt><dd>{item.projectName || '未关联项目'}{item.projectId && <code>{item.projectId}</code>}</dd></div>
          <div><dt>会话</dt><dd>{item.sessionTitle}<code>{item.sessionId}</code></dd></div>
          <div><dt>轮次</dt><dd><code>{item.turnId}</code></dd></div>
          {item.sandboxId && <div><dt>沙箱</dt><dd><code>{item.sandboxId}</code></dd></div>}
        </dl>
        {item.sourceAvailable === false ? <p className="improvement-unavailable">来源会话已删除，建议记录继续保留。</p> : <button className="secondary-button" disabled={opening} onClick={async () => {
          setOpening(true); setError('');
          try { await onOpenSession(item.sessionId); }
          catch (err) { setError(errorMessage(err)); }
          finally { setOpening(false); }
        }}>{opening ? '打开中…' : '查看来源会话 ↗'}</button>}
        {error && <p className="improvements-error" role="alert">{error}</p>}
      </section>
    </div>
  </details>;
}

export default function ImprovementsPage({ onMenu, onBack, onOpenSession }: Props) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ q: '', category: '', projectId: '', offset: 0 });
  const [data, setData] = useState<ImprovementPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(filters.offset) });
    if (filters.q) params.set('q', filters.q);
    if (filters.category) params.set('category', filters.category);
    if (filters.projectId) params.set('projectId', filters.projectId);
    void api<ImprovementPage>(`/api/improvements?${params}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      if (filters.offset > 0 && filters.offset >= value.total) {
        setFilters(current => ({ ...current, offset: Math.max(0, Math.ceil(value.total / pageSize) - 1) * pageSize }));
        return;
      }
      setData(value);
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, revision]);
  const filtered = Boolean(filters.q || filters.category || filters.projectId);
  return <main className="main-pane improvements-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>改进建议</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="improvements-scroll">
      <div className="improvements-heading"><div><span className="improvements-eyebrow">CONTINUOUS IMPROVEMENT</span><h1>改进建议</h1><p>查看 Agent 在工作中提出的建议，展开了解依据、改进办法和来源。</p></div><button className="secondary-button" disabled={loading} onClick={() => setRevision(value => value + 1)}><Icon name="refresh" size={14} />{loading ? '读取中…' : '刷新'}</button></div>
      <form className="improvements-filters" role="search" onSubmit={event => { event.preventDefault(); setFilters(current => ({ ...current, q: query.trim(), offset: 0 })); }}>
        <div className="improvements-search"><input type="search" aria-label="搜索建议" maxLength={200} placeholder="搜索标题、问题或建议内容" value={query} onChange={event => setQuery(event.target.value)} /><button className="secondary-button" type="submit">搜索</button></div>
        <label>分类<select aria-label="分类" value={filters.category} onChange={event => setFilters(current => ({ ...current, category: event.target.value, offset: 0 }))}><option value="">全部分类</option>{filters.category && !data?.categories.includes(filters.category) && <option value={filters.category}>{filters.category}</option>}{data?.categories.map(category => <option key={category} value={category}>{category}</option>)}</select></label>
        <label>项目<select aria-label="项目" value={filters.projectId} onChange={event => setFilters(current => ({ ...current, projectId: event.target.value, offset: 0 }))}><option value="">全部项目</option>{filters.projectId && !data?.projects.some(project => project.id === filters.projectId) && <option value={filters.projectId}>{filters.projectId}</option>}{data?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        {filtered && <button type="button" className="improvements-clear" onClick={() => { setQuery(''); setFilters({ q: '', category: '', projectId: '', offset: 0 }); }}>清除筛选</button>}
      </form>
      {error && <div className="improvements-error" role="alert"><span>读取建议失败：{error}</span><button className="secondary-button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
      <section aria-label="改进建议列表" aria-busy={loading} className="improvements-list">
        {loading ? <div className="improvements-empty" role="status"><span className="spinner" /> 正在读取建议…</div> : !error && (!data || !data.items.length) ? <div className="improvements-empty"><Icon name="chat" size={28} /><h2>{filtered ? '没有匹配的建议' : '还没有改进建议'}</h2><p>{filtered ? '调整搜索词或筛选条件后再试。' : 'Agent 发现值得改进的地方并提交后，会展示在这里。'}</p></div> : !error && data?.items.map(item => <ProposalCard key={item.id} item={item} onOpenSession={onOpenSession} />)}
      </section>
      {!loading && !error && data && data.total > 0 && <nav className="improvements-pagination" aria-label="建议分页"><span>共 {data.total} 条 · 第 {Math.floor(filters.offset / pageSize) + 1} / {Math.ceil(data.total / pageSize)} 页</span><div><button className="secondary-button" disabled={filters.offset === 0} onClick={() => setFilters(current => ({ ...current, offset: Math.max(0, current.offset - pageSize) }))}>上一页</button><button className="secondary-button" disabled={filters.offset + pageSize >= data.total} onClick={() => setFilters(current => ({ ...current, offset: current.offset + pageSize }))}>下一页</button></div></nav>}
    </div>
  </main>;
}
