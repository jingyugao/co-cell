import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagedImage, ImportImageInput, ImageVersion } from '../../../protocol/image-types';
import { api } from '../../lib/api';
import '../projects/ProjectsPage.css';
import './ImagesPage.css';

const statusLabels: Record<ImageVersion['status'], string> = { submitting: '提交中', queued: '等待构建', running: '构建中', succeeded: '可用', failed: '导入失败', unknown: '结果待确认' };
type FormTarget = { image?: ManagedImage; retry?: ImageVersion };

function ImportForm({ target, categories, busy, onSubmit, onCancel }: {
  target: FormTarget; categories: string[]; busy: boolean;
  onSubmit: (input: ImportImageInput) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('开发环境');
  const [version, setVersion] = useState('');
  const [url, setUrl] = useState('');
  const [buildCommand, setBuildCommand] = useState('');
  const [privateRegistry, setPrivateRegistry] = useState(Boolean(target.retry?.registryAuthRequired));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const retry = target.retry;
  return <form className="project-form image-import-form" aria-label={retry ? '确认导入结果' : '导入镜像'} onSubmit={async event => {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setError('');
    try {
      await onSubmit({ ...(target.image ? { imageId: target.image.id } : { name: name.trim(), category: category.trim() }),
        version: version.trim(), url: url.trim(), ...(buildCommand.trim() ? { buildCommand } : {}),
        ...(privateRegistry ? { registryAuth: { username, password } } : {}) });
    } catch (err) { setError(err instanceof Error ? err.message : '导入失败，请重试'); }
    finally { pending.current = false; }
  }}>
    <h2>{retry ? '确认导入结果' : target.image ? `新增版本 · ${target.image.name}` : '导入新镜像'}</h2>
    {retry ? <p className="project-form-hint">将使用原镜像地址、构建命令及请求标识重新确认结果。</p> : <>
      {!target.image && <div className="image-form-row"><label>镜像类型<input required maxLength={100} list="image-categories" value={category} disabled={busy} onChange={event => setCategory(event.target.value)} /><datalist id="image-categories">{categories.map(value => <option key={value} value={value} />)}</datalist></label><label>镜像名称<input required maxLength={100} value={name} disabled={busy} placeholder="例如：Python 开发环境" onChange={event => setName(event.target.value)} /></label></div>}
      <div className="image-form-row"><label>版本名称<input required maxLength={100} value={version} disabled={busy} placeholder="例如：v1.0 或 python-3.12" onChange={event => setVersion(event.target.value)} /></label><label>Docker 镜像地址<input required maxLength={4096} value={url} disabled={busy} placeholder="registry.example.com/team/image:v1" onChange={event => setUrl(event.target.value)} /></label></div>
      <label>构建命令（可选）<textarea rows={5} value={buildCommand} disabled={busy} placeholder="在源镜像中安装项目工具，或复制已准备好的工具文件" onChange={event => setBuildCommand(event.target.value)} /></label>
      <p className="project-form-hint">支持 linux/amd64。源镜像或构建命令须提供 /usr/local/bin/node 和 /usr/local/bin/codex；平台自动写入 CoCell 启动器。构建命令以 root 执行，镜像启动后使用普通用户。预装工具可避免构建时下载。</p>
      <p className="project-form-hint">自定义镜像使用 Cellbox 归档；平台连接凭据和受控工具仅适用于系统默认镜像。</p>
    </>}
    {(!retry || retry.registryAuthRequired) && <>
      {!retry && <label className="image-checkbox"><input type="checkbox" checked={privateRegistry} disabled={busy} onChange={event => setPrivateRegistry(event.target.checked)} />私有仓库认证</label>}
      {privateRegistry && <div className="image-form-row"><label>仓库用户名<input required autoComplete="off" value={username} disabled={busy} onChange={event => setUsername(event.target.value)} /></label><label>仓库密码 / Token<input type="password" aria-label="仓库密码 / Token" required autoComplete="new-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /><small>仅用于本次导入，不保存。</small></label></div>}
    </>}
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="project-form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="primary-button" disabled={busy}>{busy ? '提交中…' : retry ? '确认结果' : '开始导入'}</button></div>
  </form>;
}

export default function ImagesPage({ onMenu, onBack }: { onMenu: () => void; onBack: () => void }) {
  const [images, setImages] = useState<ManagedImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [form, setForm] = useState<FormTarget | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const alive = useRef(true);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await api<ManagedImage[]>('/api/images');
      if (alive.current && request === sequence.current) { setImages(next); setError(''); }
    } catch (err) { if (alive.current && request === sequence.current) setError(err instanceof Error ? err.message : '镜像读取失败'); }
    finally { if (alive.current && request === sequence.current) { setLoading(false); setRefreshTick(tick => tick + 1); } }
  }, []);
  useEffect(() => { alive.current = true; void reload(); return () => { alive.current = false; sequence.current++; }; }, [reload]);
  const importing = images.some(image => image.versions.some(version => ['queued', 'running', 'submitting'].includes(version.status) || (version.status === 'unknown' && version.operationId)));
  useEffect(() => {
    if (!importing || busy) return;
    const timer = setTimeout(() => void reload(), 3000);
    return () => clearTimeout(timer);
  }, [importing, refreshTick, busy, reload]);
  const categories = [...new Set(images.map(image => image.category))];
  const visible = images.filter(image => (!category || category === image.category) &&
    `${image.name} ${image.category} ${image.versions.map(version => `${version.version} ${version.source}`).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="main-pane projects-page images-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>系统管理</span><span className="slash">/</span><strong>镜像</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="projects-scroll"><div className="projects-heading"><div><span className="projects-eyebrow">IMAGE LIBRARY</span><h1>镜像管理</h1><p>按类型管理开发环境，为每个镜像保存独立版本。</p></div><button className="primary-button" disabled={busy || Boolean(form)} onClick={() => setForm({})}>＋ 导入镜像</button></div>
      {form && <div className="project-create-panel"><ImportForm key={`${form.image?.id ?? 'new'}:${form.retry?.id ?? 'import'}`} target={form} categories={categories} busy={busy} onCancel={() => setForm(null)} onSubmit={async input => {
        setBusy(true);
        try {
          const path = form.retry ? `/api/images/${encodeURIComponent(form.image!.id)}/versions/${encodeURIComponent(form.retry.id)}/retry` : '/api/images/import';
          const next = await api<ManagedImage>(path, { method: 'POST', body: JSON.stringify(form.retry ? (input.registryAuth ? { registryAuth: input.registryAuth } : {}) : input) });
          if (!alive.current) return;
          sequence.current++;
          setImages(current => [next, ...current.filter(image => image.id !== next.id)]); setForm(null);
          await reload();
        } finally { if (alive.current) setBusy(false); }
      }} /></div>}
      <div className="projects-toolbar"><div className="image-filters"><input aria-label="搜索镜像" placeholder="搜索镜像、版本或地址…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="筛选镜像类型" value={category} onChange={event => setCategory(event.target.value)}><option value="">全部类型</option>{categories.map(value => <option key={value}>{value}</option>)}</select></div><button className="secondary-button" disabled={busy} onClick={() => void reload()}>刷新</button></div>
      {error && <p className="project-error" role="alert">{error}</p>}
      {loading ? <p className="projects-empty">正在读取镜像…</p> : !visible.length ? <p className="projects-empty">{query || category ? '没有匹配的镜像。' : '尚无镜像，导入第一个开发环境。'}</p> : <div className="image-library">{visible.map(image => <article className="image-card" key={image.id}>
        <header><div><span className="project-type-badge">{image.category}</span><h2>{image.name}</h2><span className="image-count">{image.versions.length} 个版本{image.origin === 'cellbox' ? ' · Cellbox 已有镜像' : ''}</span></div>{image.origin !== 'profile' && <button className="secondary-button" disabled={busy || Boolean(form)} onClick={() => setForm({ image })}>＋ 新增版本</button>}</header>
        <div className="image-versions">{image.versions.map(version => <section className="image-version" key={version.id}><div className="image-version-heading"><strong>{version.version}</strong><span className={`image-status ${version.status}`}>{version.projectReady === false ? '需配置运行环境' : statusLabels[version.status]}</span>{version.createdAt && <time>{new Date(version.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>}</div>
          <div className="image-reference"><span>源镜像</span><code>{version.source}</code></div>
          {version.image && <div className="image-reference"><span>固定镜像</span><code>{version.image}</code></div>}
          {version.projectReady === false && <p className="project-form-hint">此版本未配置 CoCell 启动器，可通过新增版本重新导入后用于项目。</p>}
          {version.error && <p className="project-error" role="alert">{version.error}</p>}
          {version.warnings?.length ? <details><summary>导入说明（{version.warnings.length}）</summary><ul>{version.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
          {version.buildCommand && <details><summary>构建命令</summary><pre>{version.buildCommand}</pre></details>}
          {version.status === 'unknown' && image.origin !== 'profile' && <button className="secondary-button" disabled={busy || Boolean(form)} onClick={() => setForm({ image, retry: version })}>确认导入结果</button>}
        </section>)}</div>
      </article>)}</div>}
    </div>
  </main>;
}
