import { useEffect, useState } from 'react';
import type { SecretMetadata, SecretVersion } from '../../../protocol/secret-types';
import { TOOL_NAME_PATTERN } from '../../../util/tool-secrets';
import { api, errorMessage } from '../../lib/api';
import './SecretManager.css';

export default function SecretManager() {
  const [items, setItems] = useState<SecretMetadata[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState<SecretMetadata | 'new' | null>(null);
  const [name, setName] = useState(''), [mutable, setMutable] = useState(false);
  const [content, setContent] = useState(''), [original, setOriginal] = useState('');
  const [tool, setTool] = useState(''), [path, setPath] = useState('');
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
      setName(item?.name ?? ''); setMutable(item?.mutable ?? false);
      setTool(item?.tool ?? ''); setPath(item?.path ?? '');
      setContent(value.content); setOriginal(value.content); setEditing(item ?? 'new'); setHistory(null);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > 65536 || !file.size) { setError('文件必须为 1..65536 字节'); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setContent(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
      setError('');
    } catch { setError('请上传 UTF-8 编码的原始文本文件'); }
  }
  return <>
    <div className="connections-heading"><div><h1>Secret 管理</h1><p>填写工具名、认证文件路径和原始文本内容，然后在项目中授权。</p></div><button className="primary-button" disabled={busy} onClick={() => void edit()}>新建 Secret</button></div>
    {error && <p className="connections-error" role="alert">{error}</p>}
    {editing && <form className="secret-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        const config = { tool: tool.trim(), path };
        if (editing === 'new') await api('/api/secrets', { method: 'POST', body: JSON.stringify({ name, format: 'text', mutable, content, ...config }) });
        else await api(`/api/secrets/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ name, mutable, ...config, ...(content !== original || editing.requiresTextImport ? { content } : {}) }) });
        close(); await refresh();
      } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
    }}>
      <h2>{editing === 'new' ? '新建 Secret' : `编辑 ${editing.name}`}</h2>
      <label>名称<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>工具名<input required maxLength={64} pattern={TOOL_NAME_PATTERN.source} value={tool} onChange={event => setTool(event.target.value)} placeholder="例如 mysql、kubectl 或自定义 CLI 名称" /></label>
      <label>认证文件路径<input required maxLength={256} value={path} onChange={event => setPath(event.target.value)} placeholder="例如 .my.cnf、.kube/config" /></label>
      <p>路径相对于工具运行的 HOME。内容按 UTF-8 文本原样使用，不做格式转换。</p>
      {editing !== 'new' && editing.requiresTextImport && <p className="connections-error">此密钥使用旧格式，请重新上传或粘贴原始文本认证文件。保存后生效。</p>}
      <label>上传文件<input type="file" onChange={e => void upload(e.target.files?.[0])} /></label>
      <label>认证内容<textarea required spellCheck={false} autoComplete="off" rows={12} value={content} onChange={e => setContent(e.target.value)} placeholder="粘贴工具原生认证文件的完整文本内容" /></label>
      <label className="secret-checkbox"><input type="checkbox" checked={mutable} onChange={e => setMutable(e.target.checked)} />允许工具更新此文件</label>
      <p>更新后最后保存的内容生效。凭证及更新历史加密存储。</p>
      <div className="secret-actions"><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存'}</button><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button></div>
    </form>}
    {loading ? <p role="status">正在读取 Secret…</p> : !items.length ? <div className="connections-empty">尚未创建 Secret。新建后，在项目的“工具权限”中绑定。</div> : <div className="secret-list">{items.map(item => <article className="connection-card" key={item.id}>
      <div className="connection-profile-title"><strong>{item.name}</strong><span>{item.enabled ? '启用' : '停用'}</span></div>
      <p>{item.tool ?? '待填写工具'} · {item.path ?? '待填写路径'} · text · v{item.version} · {item.mutable ? '工具可更新' : '管理员维护'} · {item.projectIds.length} 个项目{item.requiresTextImport && ' · 需重新导入文本'}</p>
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
