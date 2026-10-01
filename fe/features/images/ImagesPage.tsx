import { useCallback, useEffect, useRef, useState } from 'react';
import type { AddImageRepositoryInput, ManagedImage, RegistryAuth, SyncImageVersionInput } from '../../../protocol/image-types';
import { api } from '../../lib/api';
import RepositoryForm from './RepositoryForm';
import RepositoryDetails from './RepositoryDetails';
import '../projects/ProjectsPage.css';
import './ImagesPage.css';

export default function ImagesPage({ onMenu, onBack }: { onMenu: () => void; onBack: () => void }) {
  const [images, setImages] = useState<ManagedImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const alive = useRef(true);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await api<ManagedImage[]>('/api/images');
      if (alive.current && request === sequence.current) { setImages(next); setError(''); }
    } catch (err) { if (alive.current && request === sequence.current) setError(err instanceof Error ? err.message : '仓库读取失败'); }
    finally { if (alive.current && request === sequence.current) { setLoading(false); setRefreshTick(tick => tick + 1); } }
  }, []);
  useEffect(() => { alive.current = true; void reload(); return () => { alive.current = false; sequence.current++; }; }, [reload]);
  const importing = images.some(image => image.versions.some(version => ['queued', 'running', 'submitting'].includes(version.status) || version.status === 'unknown' && version.operationId || version.cleanup && version.cleanup.status !== 'failed' && version.cleanup.operationId));
  useEffect(() => {
    if (!importing || busy) return;
    const timer = setTimeout(() => void reload(), 3000);
    return () => clearTimeout(timer);
  }, [importing, refreshTick, busy, reload]);
  async function mutate(path: string, input: unknown, method = 'POST') {
    setBusy(true);
    try {
      const next = await api<ManagedImage>(path, { method, ...(method === 'DELETE' ? {} : { body: JSON.stringify(input) }) });
      if (!alive.current) return;
      sequence.current++;
      setImages(current => [next, ...current.filter(image => image.id !== next.id)]);
      return next;
    } finally { if (alive.current) setBusy(false); }
  }
  const categories = [...new Set(images.map(image => image.category))];
  const visible = images.filter(image => (!category || category === image.category) &&
    `${image.name} ${image.category} ${image.repository ?? ''} ${image.versions.map(version => version.version).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const selected = images.find(image => image.id === selectedId);
  return <main className="main-pane projects-page images-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>系统管理</span><span className="slash">/</span><strong>镜像仓库</strong>{selected && <><span className="slash">/</span><strong>{selected.name}</strong></>}</div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="projects-scroll">
      {error && <p className="project-error" role="alert">{error}</p>}
      {selected ? <RepositoryDetails key={selected.id} image={selected} busy={busy} onBack={() => setSelectedId(null)}
        onDefault={async versionId => { await mutate(`/api/images/${encodeURIComponent(selected.id)}/versions/${encodeURIComponent(versionId)}/default`, {}); }}
        onDelete={async versionId => { await mutate(`/api/images/${encodeURIComponent(selected.id)}/versions/${encodeURIComponent(versionId)}`, undefined, 'DELETE'); }}
        onSync={async (input: SyncImageVersionInput) => { await mutate(`/api/images/${encodeURIComponent(selected.id)}/versions/sync`, input); }}
        onRetry={async (versionId: string, registryAuth?: RegistryAuth) => { await mutate(`/api/images/${encodeURIComponent(selected.id)}/versions/${encodeURIComponent(versionId)}/retry`, registryAuth ? { registryAuth } : {}); }} /> : <>
        <div className="projects-heading"><div><span className="projects-eyebrow">IMAGE REPOSITORIES</span><h1>镜像管理</h1><p>先添加镜像仓库，再进入仓库选择并同步上游版本。</p></div><button className="primary-button" disabled={busy || adding} onClick={() => setAdding(true)}>＋ 添加仓库</button></div>
        {adding && <div className="project-create-panel"><RepositoryForm categories={categories} busy={busy} onCancel={() => setAdding(false)} onSubmit={async (input: AddImageRepositoryInput) => {
          const next = await mutate('/api/images/repositories', input);
          if (next) { setAdding(false); setSelectedId(next.id); }
        }} /></div>}
        <div className="projects-toolbar"><div className="image-filters"><input aria-label="搜索镜像仓库" placeholder="搜索仓库、类型或版本…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="筛选镜像类型" value={category} onChange={event => setCategory(event.target.value)}><option value="">全部类型</option>{categories.map(value => <option key={value}>{value}</option>)}</select></div><button className="secondary-button" disabled={busy} onClick={() => void reload()}>刷新</button></div>
        {loading ? <p className="projects-empty">正在读取仓库…</p> : !visible.length ? <p className="projects-empty">{query || category ? '没有匹配的仓库。' : '尚无镜像仓库，添加第一个开发环境。'}</p> : <div className="image-library">{visible.map(image => <article className="image-card" key={image.id}>
          <header><div><span className="project-type-badge">{image.category}</span><h2>{image.name}</h2><span className="image-count">{new Set(image.versions.filter(version => version.status === 'succeeded').map(version => version.version)).size} 个已同步版本{image.origin === 'profile' ? ' · 系统配置' : image.origin === 'cellbox' ? ' · Cellbox 已有镜像' : ''}</span></div><button className="secondary-button" disabled={busy || adding} onClick={() => setSelectedId(image.id)}>{image.origin === 'managed' ? '进入仓库' : '查看版本'}</button></header>
          {image.repository && <div className="image-reference"><span>仓库</span><code>{image.repository}</code></div>}
          {image.versions.some(version => ['queued', 'running', 'submitting'].includes(version.status)) && <p className="project-form-hint">版本同步中…</p>}
        </article>)}</div>}
      </>}
    </div>
  </main>;
}
