import { useEffect, useRef, useState } from 'react';
import type { ManagedImage, ImageVersion, RegistryAuth, RegistryTagsPage, SyncImageVersionInput } from '../../../protocol/image-types';
import { api } from '../../lib/api';

const statusLabels: Record<ImageVersion['status'], string> = { submitting: '提交中', queued: '等待构建', running: '构建中', succeeded: '可用', failed: '构建失败', unknown: '结果未知' };

export default function RepositoryDetails({ image, busy, onBack, onSync, onDefault, onDeprecated, initialLifecycle = 'active' }: {
  initialLifecycle?: string; image: ManagedImage; busy: boolean; onBack: () => void;
  onSync: (input: SyncImageVersionInput) => Promise<void>;
  onDefault: (versionId: string) => Promise<void>;
  onDeprecated: (versionId: string, deprecated: boolean) => Promise<void>;
}) {
  const [tags, setTags] = useState<string[]>([]);
  const [next, setNext] = useState<string>();
  const [queried, setQueried] = useState(false);
  const [reading, setReading] = useState(false);
  const [query, setQuery] = useState('');
  const [privateRegistry, setPrivateRegistry] = useState(Boolean(image.registryAuthRequired));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lifecycle, setLifecycle] = useState(initialLifecycle);
  const alive = useRef(true);
  const pending = useRef(false);
  const sequence = useRef(0);
  const managed = image.origin === 'managed' && Boolean(image.repository);
  const buildAllowed = managed && !image.registryAuthRequired && image.templateStatus !== 'unknown' && image.templateStatus !== 'failed' && Boolean(image.templateId);
  function credentials(): RegistryAuth | undefined {
    if (!privateRegistry) return undefined;
    if (!username || !password) throw new Error('请填写仓库用户名和 Token');
    return { username, password };
  }
  async function loadTags(more = false) {
    if (pending.current) return;
    pending.current = true;
    setReading(true); setError('');
    const request = ++sequence.current;
    try {
      const registryAuth = credentials();
      const page = await api<RegistryTagsPage>(`/api/images/${encodeURIComponent(image.id)}/tags`, { method: 'POST',
        body: JSON.stringify({ ...(registryAuth ? { registryAuth } : {}), ...(more && next ? { last: next } : {}) }) });
      if (!alive.current || request !== sequence.current) return;
      setTags(current => [...new Set([...(more ? current : []), ...page.tags])]); setNext(page.next); setQueried(true);
    } catch (err) { if (alive.current && request === sequence.current) setError(err instanceof Error ? err.message : '查询版本失败'); }
    finally { pending.current = false; if (alive.current) setReading(false); }
  }
  useEffect(() => {
    alive.current = true;
    const timer = managed && !image.registryAuthRequired ? setTimeout(() => void loadTags(), 0) : undefined;
    return () => { clearTimeout(timer); alive.current = false; sequence.current++; };
  }, [image.id]);
  async function action(work: () => Promise<void>, message: string) {
    if (pending.current) return;
    pending.current = true; setError(''); setNotice('');
    try { await work(); if (alive.current) setNotice(message); }
    catch (err) { if (alive.current) setError(err instanceof Error ? err.message : '操作失败'); }
    finally { pending.current = false; }
  }
  const blocked = busy || reading;
  const visibleVersions = image.versions.filter(version => lifecycle === 'all' || (lifecycle === 'deprecated') === Boolean(version.deprecatedAt));
  const visibleTags = tags.filter(tag => tag.toLowerCase().includes(query.toLowerCase()));
  return <div className="repository-details">
    <div className="projects-heading"><div><span className="projects-eyebrow">CELLBOX TEMPLATE</span><h1>{image.name}</h1><p>{image.repository ?? image.templateId ?? '系统默认 template'}</p><p className="project-form-hint">新建 Sandbox 和归档恢复默认使用所选镜像的最新成功版本，无需逐个版本设置默认。归档恢复时也可手动选择版本。</p></div><button className="secondary-button" disabled={busy} onClick={onBack}>返回仓库列表</button></div>
    {image.migrationRequired && <p className="project-error" role="status">此记录仍使用旧 importedImage，需迁移到 Cellbox template/revision 后才能用于新项目。</p>}
    {image.templateStatus && image.templateStatus !== 'ready' && <p className="project-error" role="status">Template 状态：{image.templateStatus === 'unknown' ? '创建结果未知' : image.templateStatus === 'failed' ? '创建失败' : '提交中'}{image.error ? ` · ${image.error}` : ''}</p>}
    {managed && <>
      <section className="image-card image-import-form">
        <h2>仓库配置</h2><p className="project-form-hint">每次同步都会向 Cellbox 提交一次新的 revision 构建。Tag 不变也会产生新构建，结果未知时不会自动重放。</p>
        {image.buildCommand && <details><summary>构建命令</summary><pre>{image.buildCommand}</pre></details>}
        <p className="project-form-hint">支持 linux/amd64。CoCell 会把上游镜像地址转换为 Cellbox 的 baseImage，并写入 CoCell 启动器。</p>
        <label className="image-checkbox"><input type="checkbox" checked={privateRegistry} disabled={blocked || image.registryAuthRequired} onChange={event => setPrivateRegistry(event.target.checked)} />私有仓库认证</label>
        {privateRegistry && <div className="image-form-row"><label>仓库用户名<input autoComplete="off" maxLength={1024} value={username} disabled={blocked} onChange={event => setUsername(event.target.value)} /></label><label>仓库密码 / Token<input aria-label="仓库密码 / Token" type="password" autoComplete="new-password" maxLength={8192} value={password} disabled={blocked} onChange={event => setPassword(event.target.value)} /><small>仅用于当前页面查询上游 Tag，不保存。</small></label></div>}
        {image.registryAuthRequired && <p className="project-error">Cellbox 当前不接受请求级 Registry 凭据，私有仓库构建暂不支持；需在 Cellbox 部署侧配置访问凭据。</p>}
        <div className="project-form-actions"><button className="secondary-button" disabled={blocked} onClick={() => void loadTags()}>{reading ? '查询中…' : queried ? '刷新上游版本' : '查询上游版本'}</button></div>
      </section>
      <section className="image-card">
        <header><h2>上游版本</h2><input aria-label="搜索上游版本" placeholder="搜索已加载的 Tag…" value={query} onChange={event => setQuery(event.target.value)} /></header>
        {!queried ? <p className="project-form-hint">{reading ? '正在查询上游版本…' : '查询仓库后选择需要构建的版本。'}</p> : !visibleTags.length ? <p className="project-form-hint">{query ? '没有匹配的 Tag。' : '仓库暂无 Tag。'}</p> : <div className="repository-tags">{visibleTags.map(tag => {
          const version = image.versions.find(value => value.userVersion === tag || value.version === tag);
          const syncing = version && ['queued', 'running', 'submitting'].includes(version.status);
          return <div className="repository-tag" key={tag}><code>{tag}</code><span className={`image-status ${version?.status ?? ''}`}>{version ? statusLabels[version.status] : '未构建'}</span><button className="secondary-button" disabled={blocked || !buildAllowed || Boolean(syncing)} aria-label={`为 ${tag} 构建新 revision`} onClick={() => void action(async () => { await onSync({ tag }); }, `已提交 ${tag} 的新 revision 构建。`)}>构建新 revision</button></div>;
        })}</div>}
        {next && <div className="project-form-actions"><button className="secondary-button" disabled={blocked} onClick={() => void loadTags(true)}>加载更多版本</button></div>}
      </section>
    </>}
    {error && <p className="project-error" role="alert">{error}</p>}
    {notice && <p className="project-form-hint" role="status">{notice}</p>}
    <section className="image-card"><header><h2>Cellbox revisions</h2><select aria-label="筛选版本生效状态" value={lifecycle} onChange={event => setLifecycle(event.target.value)}><option value="active">生效中</option><option value="deprecated">已退休</option><option value="all">全部</option></select><span className="image-count">{visibleVersions.length} 个 revision</span></header>
      {!image.versions.length && <p className="project-form-hint">暂无 revision。</p>}
      {visibleVersions.map(version => <section className="image-version" key={version.id}>
        <div className="image-version-heading"><strong>{version.version}</strong>{version.isDefault && <span className="project-type-badge image-global-default">默认镜像参考版本</span>}{version.deprecatedAt && <span className="project-type-badge">已退休</span>}{image.defaultVersionId === version.id && <span className="project-type-badge">Cellbox stable</span>}<span className={`image-status ${version.status}`}>{version.migrationRequired ? '需要迁移' : statusLabels[version.status]}</span>{version.createdAt && <time>{new Date(version.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>}</div>
        {version.revisionId && <div className="image-reference"><span>Revision ID</span><code>{version.revisionId}</code></div>}
        {version.source && <div className="image-reference"><span>基础镜像</span><code>{version.source}</code></div>}
        {version.image && <div className="image-reference"><span>固定镜像</span><code>{version.image}</code></div>}
        {version.operationId && <div className="image-reference"><span>Build operation</span><code>{version.operationId}</code></div>}
        {version.error && <p className="project-error">{version.error}</p>}
        {version.migrationRequired && <p className="project-form-hint">旧 importedImage ID 只用于识别旧记录，不代表 Cellbox revision。</p>}
        {image.origin !== 'profile' && version.revisionId && <div className="project-form-actions">
          {version.status === 'succeeded' && !version.deprecatedAt && !version.isDefault && <button className="secondary-button" disabled={blocked} onClick={() => void action(() => onDefault(version.id), '默认镜像已更新；新项目自动使用该镜像的 latest。')}>设为 CoCell 默认</button>}
          {!version.deprecatedAt && <button className="secondary-button" disabled={blocked || version.isDefault} title={version.isDefault ? '请先切换 CoCell 默认 revision' : undefined} onClick={() => void action(async () => {
            if (!window.confirm(`退休 ${version.version}？Cellbox 会阻止后续选择此 revision，已有 sandbox 不受影响。`)) return;
            await onDeprecated(version.id, true);
          }, 'Cellbox revision 已退休。')}>退休 revision</button>}
          {version.deprecatedAt && <button className="secondary-button" disabled={blocked} onClick={() => void action(() => onDeprecated(version.id, false), 'Cellbox revision 已恢复 active。')}>恢复 active</button>}
        </div>}
      </section>)}
    </section>
  </div>;
}
