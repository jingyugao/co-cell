import { useEffect, useRef, useState } from 'react';
import type { ManagedImage, ImageVersion, ImageVersionUsage, RegistryAuth, RegistryTagsPage, SyncImageVersionInput } from '../../../protocol/image-types';
import { api } from '../../lib/api';

const statusLabels: Record<ImageVersion['status'], string> = { submitting: '提交中', queued: '等待构建', running: '同步中', succeeded: '已同步', failed: '同步失败', unknown: '结果待确认' };

export default function RepositoryDetails({ image, busy, onBack, onSync, onRetry, onDefault, onDelete, onDeprecated, initialLifecycle = 'active' }: {
  initialLifecycle?: string; image: ManagedImage; busy: boolean; onBack: () => void;
  onSync: (input: SyncImageVersionInput) => Promise<void>;
  onRetry: (versionId: string, auth?: RegistryAuth) => Promise<void>;
  onDefault: (versionId: string) => Promise<void>;
  onDelete: (versionId: string) => Promise<void>;
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
    catch (err) { if (alive.current) setError(err instanceof Error ? err.message : '同步失败'); }
    finally { pending.current = false; }
  }
  const blocked = busy || reading;
  async function remove(version: ImageVersion) {
    await action(async () => {
      if (!version.cleanup) {
        const usage = await api<ImageVersionUsage>(`/api/images/${encodeURIComponent(image.id)}/versions/${encodeURIComponent(version.id)}/usage`);
        if (!usage.deletable) throw new Error(usage.blockers.join('；') || 'Cellbox 暂不允许清理此镜像');
        if (!window.confirm(`清理 ${version.version}？运行中和 Checkpoint 项目的版本受保护；归档恢复将使用仓库默认版本。${usage.manifestShared ? '其他版本共享此镜像，只移除此版本记录。' : '将删除成品镜像，磁盘空间由 Registry GC 和节点缓存回收释放。'}`)) return;
      }
      await onDelete(version.id);
    }, '清理请求已处理，请查看版本状态。');
  }
  const visibleVersions = image.versions.filter(version => lifecycle === 'all' || (lifecycle === 'deprecated') === Boolean(version.deprecatedAt));
  const visibleTags = tags.filter(tag => tag.toLowerCase().includes(query.toLowerCase()));
  return <div className="repository-details">
    <div className="projects-heading"><div><span className="projects-eyebrow">REPOSITORY VERSIONS</span><h1>{image.name}</h1><p>{image.repository ?? '系统默认开发环境'}</p></div><button className="secondary-button" disabled={busy} onClick={onBack}>返回仓库列表</button></div>
    {managed && <>
      <section className="image-card image-import-form">
        <h2>仓库配置</h2><p className="project-form-hint">版本名与上游 Tag 一致。运行中和 Checkpoint 项目固定原版本；归档项目恢复时优先使用本仓库默认版本。首个同步成功的版本自动设为默认，后续可手动切换。</p>
        {image.buildCommand && <details><summary>构建命令</summary><pre>{image.buildCommand}</pre></details>}
        <p className="project-form-hint">支持 linux/amd64。源镜像或构建命令须提供 /usr/local/bin/node 和 /usr/local/bin/codex，平台自动写入 CoCell 启动器。</p>
        <label className="image-checkbox"><input type="checkbox" checked={privateRegistry} disabled={blocked || image.registryAuthRequired} onChange={event => setPrivateRegistry(event.target.checked)} />私有仓库认证</label>
        {privateRegistry && <div className="image-form-row"><label>仓库用户名<input autoComplete="off" maxLength={1024} value={username} disabled={blocked} onChange={event => setUsername(event.target.value)} /></label><label>仓库密码 / Token<input aria-label="仓库密码 / Token" type="password" autoComplete="new-password" maxLength={8192} value={password} disabled={blocked} onChange={event => setPassword(event.target.value)} /><small>仅用于当前页面的查询和同步，不保存。</small></label></div>}
        <div className="project-form-actions"><button className="secondary-button" disabled={blocked} onClick={() => void loadTags()}>{reading ? '查询中…' : queried ? '刷新上游版本' : '查询上游版本'}</button></div>
      </section>
      <section className="image-card">
        <header><h2>上游版本</h2><input aria-label="搜索上游版本" placeholder="搜索已加载的 Tag…" value={query} onChange={event => setQuery(event.target.value)} /></header>
        {!queried ? <p className="project-form-hint">{reading ? '正在查询上游版本…' : '查询仓库后选择需要同步的版本。'}</p> : !visibleTags.length ? <p className="project-form-hint">{query ? '没有匹配的 Tag。' : '仓库暂无 Tag。'}</p> : <div className="repository-tags">{visibleTags.map(tag => {
          const version = image.versions.find(value => value.version === tag);
          const syncing = version && ['queued', 'running', 'submitting', 'unknown'].includes(version.status);
          return <div className="repository-tag" key={tag}><code>{tag}</code><span className={`image-status ${version?.status ?? ''}`}>{version ? statusLabels[version.status] : '未同步'}</span><button className="secondary-button" disabled={blocked || Boolean(syncing)} aria-label={`${version?.status === 'succeeded' ? '检查并同步' : '同步'} ${tag}`} onClick={() => void action(async () => { await onSync({ tag, ...(privateRegistry ? { registryAuth: credentials() } : {}) }); }, `已提交 ${tag} 同步；源镜像未变时沿用已同步版本。`)}>{version?.status === 'succeeded' ? '检查并同步' : '同步版本'}</button></div>;
        })}</div>}
        {next && <div className="project-form-actions"><button className="secondary-button" disabled={blocked} onClick={() => void loadTags(true)}>加载更多版本</button></div>}
      </section>
    </>}
    {error && <p className="project-error" role="alert">{error}</p>}
    {notice && <p className="project-form-hint" role="status">{notice}</p>}
    <section className="image-card"><header><h2>已同步版本</h2><select aria-label="筛选版本生效状态" value={lifecycle} onChange={event => setLifecycle(event.target.value)}><option value="active">生效中</option><option value="deprecated">已弃用</option><option value="all">全部</option></select><span className="image-count">{visibleVersions.length} 条同步记录</span></header>
      {!image.versions.length && <p className="project-form-hint">尚未同步版本。同步成功后可在创建项目时选择。</p>}
      {image.versions.length > 0 && !visibleVersions.length && <p className="project-form-hint">当前状态下没有版本。</p>}
      {visibleVersions.map(version => <section className="image-version" key={version.id}>
        <div className="image-version-heading"><strong>{version.version}</strong>{version.deprecatedAt && <span className="project-type-badge">已弃用</span>}{image.defaultVersionId === version.id && <span className="project-type-badge">默认 · 归档恢复</span>}<span className={`image-status ${version.status}`}>{version.cleanup ? version.cleanup.status === 'failed' ? '清理失败' : version.cleanup.status === 'unknown' ? '清理结果待确认' : '清理中' : version.projectReady === false ? '需配置运行环境' : statusLabels[version.status]}</span>{version.createdAt && <time>{new Date(version.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>}</div>
        <div className="image-reference"><span>源镜像</span><code>{version.source}</code></div>
        {version.upstreamDigest && <div className="image-reference"><span>上游 digest</span><code>{version.upstreamDigest}</code></div>}
        {version.image && <div className="image-reference"><span>固定镜像</span><code>{version.image}</code></div>}
        {version.error && <p className="project-error">{version.error}</p>}
        {version.cleanup?.error && <p className="project-error">{version.cleanup.error}</p>}
        {version.projectReady === false && <p className="project-form-hint">该镜像未配置 CoCell 启动器，请添加源仓库并同步对应版本。</p>}
        {version.warnings?.length ? <details><summary>同步说明</summary><ul>{version.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
        {version.status === 'unknown' && managed && <button className="secondary-button" disabled={blocked} onClick={() => void action(async () => { await onRetry(version.id, version.registryAuthRequired ? credentials() : undefined); }, '已使用原请求确认同步结果。')}>确认同步结果</button>}
        {image.origin !== 'profile' && <div className="project-form-actions">
          {!version.cleanup && <button className="secondary-button" disabled={blocked} onClick={() => void action(async () => {
            if (!version.deprecatedAt && !window.confirm(`弃用 ${version.version}？已有项目继续使用，但新项目和归档恢复不能选择此版本。若它是默认版本，将切换到其他可用版本。`)) return;
            await onDeprecated(version.id, !version.deprecatedAt);
          }, version.deprecatedAt ? '版本已恢复生效。' : '版本已弃用，已有项目不受影响。')}>{version.deprecatedAt ? '恢复生效' : '标记弃用'}</button>}
        </div>}
        {managed && <div className="project-form-actions">
          {version.status === 'succeeded' && !version.deprecatedAt && version.projectReady !== false && !version.cleanup && image.defaultVersionId !== version.id && <button className="secondary-button" disabled={blocked} onClick={() => void action(() => onDefault(version.id), '已设为默认版本，归档项目恢复时优先使用。')}>设为默认版本</button>}
          {(['succeeded', 'failed'].includes(version.status) || version.cleanup) && image.defaultVersionId !== version.id && <button className="secondary-button" disabled={blocked || version.cleanup?.status === 'pending'} onClick={() => void remove(version)}>{version.cleanup ? '重试 / 确认清理' : '清理版本'}</button>}
        </div>}
      </section>)}
    </section>
  </div>;
}
