import { useCallback, useEffect, useState } from 'react';
import type { FileFavorite } from '../../../protocol/file-favorite-types.js';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';
import './FavoritesPage.css';

function dateLabel(value: string) {
  return Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '收藏时间未知';
}

export default function FavoritesPage({ onMenu, onOpenFile }: {
  onMenu: () => void;
  onOpenFile: (favorite: FileFavorite) => void;
}) {
  const [favorites, setFavorites] = useState<FileFavorite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setError('');
    try {
      const result = await api<{ favorites: FileFavorite[] }>('/api/file-favorites', { signal });
      if (!signal?.aborted) setFavorites(result.favorites);
    } catch (reason) {
      if (!signal?.aborted) setError(errorMessage(reason));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const update = () => { void refresh(); };
    window.addEventListener('cocell:file-favorite-changed', update);
    return () => { controller.abort(); window.removeEventListener('cocell:file-favorite-changed', update); };
  }, [refresh]);

  async function remove(favorite: FileFavorite) {
    if (removing) return;
    setRemoving(favorite.id); setError('');
    try {
      await api<{ ok: true }>(`/api/file-favorites/${encodeURIComponent(favorite.id)}`, { method: 'DELETE' });
      setFavorites(items => items.filter(item => item.id !== favorite.id));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setRemoving(null); }
  }

  return <main className="favorites-page">
    <header className="favorites-header">
      <button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button>
      <div><span className="favorites-eyebrow">工作区</span><h1>收藏文件</h1><p>保存常用文件的位置，打开时读取当前可用版本。</p></div>
      <button className="favorites-refresh" onClick={() => { setLoading(true); void refresh(); }} disabled={loading || removing !== null}><Icon name="refresh" size={15} />刷新</button>
    </header>
    {error && <div className="favorites-error" role="alert">{error}<button onClick={() => { setLoading(true); void refresh(); }}>重试</button></div>}
    <section className="favorites-list" aria-label="收藏文件列表" aria-busy={loading}>
      {loading ? <p className="favorites-state" role="status"><span className="spinner" />正在加载收藏…</p>
        : favorites.length === 0 ? <div className="favorites-empty"><Icon name="bookmark" size={24} /><strong>还没有收藏文件</strong><span>在文件预览中点选书签图标，即可收藏文件路径。</span></div>
        : favorites.map(favorite => <article className="favorite-row" key={favorite.id}>
          <button className="favorite-open" onClick={() => onOpenFile(favorite)} title={`打开 ${favorite.path}`}>
            <span className="favorite-file-icon"><Icon name="code" size={17} /></span>
            <span className="favorite-file-info"><strong>{favorite.path.split('/').pop() || favorite.path}</strong><span className="favorite-path">{favorite.path}</span><span className="favorite-project">{favorite.projectName} · 收藏于 {dateLabel(favorite.createdAt)}</span></span>
          </button>
          <button className="favorite-remove" aria-label={`移除收藏：${favorite.path}`} disabled={removing !== null} onClick={() => void remove(favorite)}>
            {removing === favorite.id ? <span className="spinner" /> : <Icon name="trash" size={16} />}
          </button>
        </article>)}
    </section>
  </main>;
}
