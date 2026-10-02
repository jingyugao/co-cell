import { useEffect, useState } from 'react';
import { PROXY_TOOLS, type ProxyTool, type SecretFormat, type SecretMetadata, type SecretVersion } from '../../../protocol/secret-types';
import { defaultCredentialPath, TOOL_LABELS } from '../../../util/tool-secrets';
import { api, errorMessage } from '../../lib/api';
import './SecretManager.css';

export default function SecretManager() {
  const [items, setItems] = useState<SecretMetadata[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState<SecretMetadata | 'new' | null>(null);
  const [name, setName] = useState(''), [format, setFormat] = useState<SecretFormat>('text'), [mutable, setMutable] = useState(false);
  const [content, setContent] = useState(''), [original, setOriginal] = useState('');
  const [tool, setTool] = useState<ProxyTool | ''>('mysql'), [path, setPath] = useState('.my.cnf'), [alias, setAlias] = useState('default');
  const [history, setHistory] = useState<{ name: string; rows: SecretVersion[] } | null>(null);
  async function refresh() { setItems(await api<SecretMetadata[]>('/api/secrets')); }
  useEffect(() => {
    const controller = new AbortController();
    void api<SecretMetadata[]>('/api/secrets', { signal: controller.signal }).then(setItems).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  function close() { setEditing(null); setContent(''); setOriginal(''); }
  async function edit(item?: SecretMetadata) {
    setError(''); setBusy(true);
    try {
      const value = item ? await api<{ content: string }>(`/api/secrets/${item.id}/content`) : { content: '' };
      setName(item?.name ?? ''); setFormat(item?.format ?? 'text'); setMutable(item?.mutable ?? false);
      setTool(item ? item.tool ?? '' : 'mysql'); setPath(item?.path ?? (item?.tool ? defaultCredentialPath(item.tool, item.format) : '.my.cnf')); setAlias(item?.alias ?? 'default');
      setContent(value.content); setOriginal(value.content); setEditing(item ?? 'new'); setHistory(null);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > 65536 || !file.size) { setError('文件必须为 1..65536 字节'); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setContent(format === 'binary' ? btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) : new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { setError(tool === 'mysql' && format === 'text' ? '请上传 UTF-8 编码的 .my.cnf 明文文件' : '文件编码无效；二进制文件请选择 binary'); }
  }
  return <>
    <div className="connections-heading"><div><h1>Secret 管理</h1><p>创建认证文件，并在项目中明确授权。可更新文件由工具自动回写。</p></div><button className="primary-button" disabled={busy} onClick={() => void edit()}>新建 Secret</button></div>
    {error && <p className="connections-error" role="alert">{error}</p>}
    {editing && <form className="secret-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        const config = { tool, path, alias };
        if (editing === 'new') await api('/api/secrets', { method: 'POST', body: JSON.stringify({ name, format, mutable, content, ...config }) });
        else await api(`/api/secrets/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ name, mutable, ...config, ...(content !== original ? { content } : {}) }) });
        close(); await refresh();
      } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
    }}>
      <h2>{editing === 'new' ? '新建 Secret' : `编辑 ${editing.name}`}</h2>
      <label>名称<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>所属工具<select required value={tool} onChange={event => {
        const next = event.target.value as ProxyTool; setTool(next);
        const nextFormat = editing === 'new' ? ['mysql', 'glab'].includes(next) ? 'text' : 'json' : format;
        setFormat(nextFormat); setPath(defaultCredentialPath(next, nextFormat)); setAlias('default');
        if (['mysql', 'kubectl'].includes(next)) setMutable(false);
      }}><option value="" disabled>选择工具</option>{PROXY_TOOLS.map(value => <option key={value} value={value}>{TOOL_LABELS[value]}</option>)}</select></label>
      {tool === 'mysql' && format === 'text' ? <p>认证文件：.my.cnf（明文文本）。直接粘贴或上传原始文件内容。</p>
        : <label>格式<select value={format} disabled={editing !== 'new'} onChange={e => { const value = e.target.value as SecretFormat; setFormat(value); if (tool) setPath(defaultCredentialPath(tool, value)); setContent(''); }}><option value="json">JSON 对象</option><option value="text">文本文件</option><option value="binary">二进制文件 / base64</option></select></label>}
      {tool && !['mysql', 'kubectl'].includes(tool) && <label>认证文件路径<input required maxLength={256} value={path} onChange={event => setPath(event.target.value)} /></label>}
      {tool === 'mysql' && format === 'binary' && <label>登录配置名称<input required maxLength={64} pattern="[A-Za-z][A-Za-z0-9_.-]*" value={alias} onChange={event => setAlias(event.target.value)} /><span>填写上传的 .mylogin.cnf 中的 login-path 名称。</span></label>}
      <label>上传文件<input type="file" onChange={e => void upload(e.target.files?.[0])} /></label>
      <label>认证内容<textarea required spellCheck={false} autoComplete="off" rows={12} value={content} onChange={e => setContent(e.target.value)} placeholder={tool === 'mysql' && format === 'text' ? '[client]\nhost="db.example.com"\nport=3306\nuser="app_user"\npassword="你的密码"\ndatabase="app_db"' : format === 'json' ? '{"access_token":"...","refresh_token":"..."}' : '文件内容'} /></label>
      <label className="secret-checkbox"><input type="checkbox" checked={mutable} disabled={tool === 'mysql' || tool === 'kubectl'} onChange={e => setMutable(e.target.checked)} />允许指定工具更新此文件</label>
      <p>更新后最后保存的内容生效。MySQL 和 Kubernetes 配置由管理员维护。</p>
      <div className="secret-actions"><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存'}</button><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button></div>
    </form>}
    {loading ? <p role="status">正在读取 Secret…</p> : !items.length ? <div className="connections-empty">尚未创建 Secret。新建后，在项目的“工具权限”中绑定。</div> : <div className="secret-list">{items.map(item => <article className="connection-card" key={item.id}>
      <div className="connection-profile-title"><strong>{item.name}</strong><span>{item.enabled ? '启用' : '停用'}</span></div>
      <p>{item.tool ? TOOL_LABELS[item.tool] : '待选择工具'} · {item.format} · v{item.version} · {item.mutable ? '工具可更新' : '管理员维护'} · {item.projectIds.length} 个项目</p>
      <p>最近更新 {new Date(item.updatedAt).toLocaleString()}</p>
      <div className="secret-actions"><button className="secondary-button" disabled={busy} onClick={() => void edit(item)}>编辑</button><button className="secondary-button" disabled={busy} onClick={async () => {
        setBusy(true); setError(''); try { await api(`/api/secrets/${item.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }) }); await refresh(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      }}>{item.enabled ? '停用' : '启用'}</button><button className="secondary-button" disabled={busy} onClick={async () => {
        setBusy(true); setError(''); try { setHistory({ name: item.name, rows: await api<SecretVersion[]>(`/api/secrets/${item.id}/versions`) }); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      }}>更新记录</button></div>
    </article>)}</div>}
    {history && <section className="secret-form"><div className="secret-actions"><h2>{history.name} · 更新记录</h2><button className="secondary-button" onClick={() => setHistory(null)}>关闭</button></div><table><thead><tr><th>提交时间</th><th>来源</th><th>修改项</th><th>基础版本</th><th>项目</th></tr></thead><tbody>{history.rows.map(row => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString()}</td><td>{row.source === 'operator' ? '管理员' : '工具回写'}</td><td>{row.changes.join(', ')}</td><td>{row.baseVersion ?? '新建'}</td><td>{row.projectId ?? '—'}</td></tr>)}</tbody></table></section>}
  </>;
}
