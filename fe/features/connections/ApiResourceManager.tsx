import { useEffect, useState, type FormEvent } from 'react';
import { RESOURCE_NAME, type ApiResourceHeader, type ApiResourceSettings, type ManagedApiResource } from '../../../protocol/api-resource-types';
import { api, errorMessage } from '../../lib/api';
import { useDraftStatus } from './DraftGuard';
import EditorDialog from './EditorDialog';

const path = '/api/proxy-resources';
type Draft = ApiResourceSettings & { headers: ApiResourceHeader[] };
const initial: Draft = { name: '', description: '', endpoint: '', authHeader: '', authScheme: '', headers: [] };

function resourceDraft(item?: ManagedApiResource): Draft {
  if (!item) return initial;
  const { revision, headerNames, ...settings } = item;
  return { ...settings, headers: (headerNames ?? []).map(name => ({ name })) };
}

export default function ApiResourceManager() {
  const [items, setItems] = useState<ManagedApiResource[]>([]);
  const [editing, setEditing] = useState<ManagedApiResource | 'new' | null>(null);
  const [draft, setDraft] = useState(initial);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const saved = editing && editing !== 'new' ? editing : undefined;
  const baseline = resourceDraft(saved);
  const dirty = editing !== null && (key !== '' || JSON.stringify(draft) !== JSON.stringify(baseline));
  const guard = useDraftStatus('api-resource', dirty, busy);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void api<ManagedApiResource[]>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setItems(value);
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  function start(item?: ManagedApiResource) {
    setDraft(resourceDraft(item)); setKey(''); setError(''); setEditing(item ?? 'new');
  }
  function changeHeader(index: number, change: Partial<ApiResourceHeader>) {
    setDraft(current => ({ ...current, headers: current.headers.map((header, i) => i === index ? { ...header, ...change } : header) }));
  }
  function close() {
    if (!busy && (!guard || guard.canLeave(['api-resource']))) { setEditing(null); setDraft(initial); setKey(''); setError(''); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    const creating = editing === 'new';
    setBusy(true); setError('');
    try {
      const item = await api<ManagedApiResource>(creating ? path : path + '/' + editing.name, {
        method: creating ? 'POST' : 'PUT',
        body: JSON.stringify({ ...draft, ...(!creating && { revision: editing.revision }), ...(key && { apiKey: key }) }),
      });
      setItems(current => [...current.filter(row => row.name !== item.name), item].sort((a, b) => a.name.localeCompare(b.name)));
      setEditing(null); setDraft(initial); setKey('');
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  async function remove(item: ManagedApiResource) {
    if (!window.confirm('删除 API 资源 ' + item.name + ' 并撤销所有角色对它的访问权限？')) return;
    setBusy(true); setError('');
    try {
      await api(path + '/' + item.name, { method: 'DELETE', body: JSON.stringify({ revision: item.revision }) });
      setItems(current => current.filter(row => row.name !== item.name));
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="api-resources-title">
    <div className="connections-heading">
      <div><h2 id="api-resources-title">API 资源</h2><p>Sandbox 通过 <code>GET /proxy</code> 查看已授权资源，通过 <code>/proxy/服务名/上游路径</code> 调用接口。</p></div>
      <div className="tool-manager-actions">
        <button className="secondary-button" disabled={loading || busy} onClick={() => setReload(value => value + 1)}>刷新列表</button>
        <button className="primary-button" disabled={loading || busy} onClick={() => start()}>新建资源</button>
      </div>
    </div>
    {error && !editing && <p className="connections-error" role="alert">{error}</p>}
    {loading ? <p role="status">正在读取资源…</p> : !items.length ? <p className="connections-empty">暂无 API 资源</p>
      : <div className="connections-grid">{items.map(item => <article key={item.name} className="connection-card">
        <h3>{item.name}</h3>{item.description && <p>{item.description}</p>}
        <dl className="api-resource-details"><dt>上游地址</dt><dd>{item.endpoint}</dd>
          <dt>配置的请求头</dt><dd>{[item.authHeader, ...(item.headerNames ?? [])].filter(Boolean).join('、') || '无'}</dd></dl>
        <div className="tool-manager-actions"><button className="secondary-button" disabled={busy} onClick={() => start(item)}>编辑</button>
          <button className="secondary-button" disabled={busy} onClick={() => void remove(item)}>删除</button></div>
      </article>)}</div>}
    {editing && <EditorDialog title={editing === 'new' ? '新建 API 资源' : '编辑 ' + editing.name} busy={busy} error={error} onClose={close}>
      <form className="secret-form" onSubmit={save}>
        <label>服务名<input required disabled={busy || editing !== 'new'} pattern={RESOURCE_NAME.source} placeholder="es"
          value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>用途<input maxLength={500} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
        <label>上游地址<input type="url" required maxLength={2048} placeholder="http://service:9200" value={draft.endpoint}
          onChange={e => setDraft({ ...draft, endpoint: e.target.value })} /></label>
        <fieldset className="api-resource-headers"><legend>额外请求头</legend>
          {draft.headers.map((header, index) => {
            const canRetain = saved?.endpoint === draft.endpoint && saved.headerNames?.some(name => name.toLowerCase() === header.name.trim().toLowerCase());
            return <div className="api-resource-header-row" key={index}>
              <label>Header 名称<input required aria-label={`Header 名称 ${index + 1}`} maxLength={128} value={header.name}
                placeholder="例如 X-Tenant-ID" onChange={e => changeHeader(index, { name: e.target.value })} /></label>
              <label>Header 值<input type="password" autoComplete="new-password" aria-label={`Header 值 ${index + 1}`}
                required={!canRetain} maxLength={8192} placeholder={canRetain ? '留空保留原值' : '输入请求头的值'}
                value={header.value ?? ''} onChange={e => changeHeader(index, { value: e.target.value || undefined })} /></label>
              <button type="button" className="secondary-button" aria-label={`移除请求头 ${index + 1}`}
                onClick={() => setDraft({ ...draft, headers: draft.headers.filter((_, i) => i !== index) })}>移除</button>
            </div>;
          })}
          <button type="button" className="secondary-button" disabled={draft.headers.length >= 64}
            onClick={() => setDraft({ ...draft, headers: [...draft.headers, { name: '' }] })}>添加请求头</button>
        </fieldset>
        <label>API Key 认证头（可选）<input required={Boolean(key || draft.authScheme)} maxLength={128} placeholder="Authorization 或 token" value={draft.authHeader}
          onChange={e => setDraft({ ...draft, authHeader: e.target.value })} /></label>
        <label>认证前缀（可选）<input maxLength={64} placeholder="例如 ApiKey 或 Bearer，原始 token 留空" value={draft.authScheme}
          onChange={e => setDraft({ ...draft, authScheme: e.target.value })} /></label>
        <label>API Key<input type="password" autoComplete="new-password" required={Boolean(draft.authHeader) && (draft.endpoint !== saved?.endpoint || draft.authHeader.toLowerCase() !== saved?.authHeader.toLowerCase())}
          maxLength={8192} placeholder={editing === 'new' ? '' : '留空保留原密钥，更换上游时需重新填写'} value={key} onChange={e => setKey(e.target.value)} /></label>
        <div className="secret-actions"><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存资源'}</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button></div>
      </form>
    </EditorDialog>}
  </section>;
}
