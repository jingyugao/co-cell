import { useEffect, useState } from 'react';
import type { SecretContent, SecretDeleteResult, SecretFileIdentity, SecretFormat, SecretMetadata, SecretTextFile, SecretVersion } from '../../../protocol/secret-types';
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
  const [format, setFormat] = useState<SecretFormat>('text');
  const [files, setFiles] = useState<SecretTextFile[]>([]), [originalFiles, setOriginalFiles] = useState('');
  const [directoryMode, setDirectoryMode] = useState(false), [directory, setDirectory] = useState('');
  const [meegle, setMeegle] = useState(false);
  const [identity, setIdentity] = useState<SecretFileIdentity>({ hostname: '', username: '' });
  const [history, setHistory] = useState<{ id: string; name: string; rows: SecretVersion[] } | null>(null);
  async function refresh() { setItems(await api<SecretMetadata[]>('/api/secrets')); }
  useEffect(() => {
    const controller = new AbortController();
    void api<SecretMetadata[]>('/api/secrets', { signal: controller.signal }).then(setItems).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  function close() { setEditing(null); setContent(''); setOriginal(''); setFiles([]); setOriginalFiles(''); setIdentity({ hostname: '', username: '' }); }
  async function remove(item: SecretMetadata) {
    setBusy(true); setError('');
    try {
      await api<SecretDeleteResult>(`/api/secrets/${item.id}`, { method: 'DELETE' });
      if (editing !== null && editing !== 'new' && editing.id === item.id) close();
      if (history?.id === item.id) setHistory(null);
      setItems(previous => previous.filter(value => value.id !== item.id));
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function edit(item?: SecretMetadata) {
    setError(''); setBusy(true);
    try {
      const value: Partial<SecretContent> = item ? await api<SecretContent>(`/api/secrets/${item.id}/content`) : { content: '' };
      setName(item?.name ?? ''); setMutable(item?.mutable ?? false);
      setTool(item?.tool ?? ''); setPath(item?.path ?? '');
      setContent(value.content ?? ''); setOriginal(value.content ?? ''); setEditing(item ?? 'new'); setHistory(null);
      setDirectoryMode(!!value.directory); setDirectory(value.directory ?? '');
      setFormat(value.format ?? 'text'); setFiles(value.files ?? []); setMeegle(value.adapter === 'meegle');
      setIdentity(value.identity ?? { hostname: '', username: '' });
      setOriginalFiles(JSON.stringify({ files: value.files ?? [], ...(value.directory ? { directory: value.directory } : {}), adapter: value.adapter, identity: value.identity }));
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function upload(file: File | undefined, index?: number) {
    if (!file) return;
    if (file.size > (index === undefined ? 65536 : 524288)) { setError('文件超过大小限制'); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const value = uploadedContent(bytes);
      if (index === undefined) { if (value.encoding) throw new Error('单文件需要 UTF-8 文本'); setContent(value.content); }
      else setFiles(previous => previous.map((entry, i) => i === index ? { path: entry.path, ...value } : entry));
      setError('');
    } catch { setError('请上传 UTF-8 编码的原始文本文件'); }
  }
  function uploadedContent(bytes: Uint8Array): Pick<SecretTextFile, 'content' | 'encoding'> {
    try { return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
    catch { return { content: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')), encoding: 'base64' }; }
  }
  async function uploadDirectory(selected: FileList | null) {
    if (!selected?.length) return;
    const entries = Array.from(selected);
    if (entries.length > 128 || entries.reduce((sum, file) => sum + file.size, 0) > 524288) { setError('目录最多包含 128 份文件，总大小最多 512 KiB'); return; }
    try {
      const sourceRoot = entries[0].webkitRelativePath.split('/')[0], target = directory || sourceRoot;
      const imported = await Promise.all(entries.map(async file => ({ path: `${target}/${file.webkitRelativePath.split('/').slice(1).join('/')}`, ...uploadedContent(new Uint8Array(await file.arrayBuffer())) })));
      imported.sort((a, b) => a.path.localeCompare(b.path));
      const primary = imported.findIndex(file => /(?:^|\/)(?:config(?:\.json)?|auth\.json)$/.test(file.path));
      if (primary > 0) imported.unshift(...imported.splice(primary, 1));
      setDirectory(target); setFiles(imported); setError('');
    } catch { setError('无法读取凭证目录'); }
  }
  return <>
    <div className="connections-heading"><div><h1>Secret 管理</h1><p>保存工具的认证文件、文件组或凭证目录，然后在项目中授权。</p></div><button className="primary-button" disabled={busy} onClick={() => void edit()}>新建 Secret</button></div>
    {error && <p className="connections-error" role="alert">{error}</p>}
    {editing && <form className="secret-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        const bundle = { files, ...(directoryMode ? { directory } : {}), ...(meegle ? { adapter: 'meegle', identity } : {}) };
        const config = { tool: tool.trim(), path: format === 'files' ? files[0]?.path : path };
        const changed = editing === 'new' || editing.format !== format || editing.requiresTextImport ||
          (format === 'files' ? JSON.stringify(bundle) !== originalFiles : content !== original);
        const body = { name, mutable, ...config, ...(changed ? { format, ...(format === 'files' ? bundle : { content }) } : {}) };
        if (editing === 'new') await api('/api/secrets', { method: 'POST', body: JSON.stringify(body) });
        else await api(`/api/secrets/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        close(); await refresh();
      } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
    }}>
      <h2>{editing === 'new' ? '新建 Secret' : `编辑 ${editing.name}`}</h2>
      <label>名称<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>工具名<input required maxLength={64} pattern={TOOL_NAME_PATTERN.source} value={tool} onChange={event => { setTool(event.target.value); if (event.target.value.trim() !== 'meegle') setMeegle(false); }} placeholder="例如 mysql、kubectl 或自定义 CLI 名称" /></label>
      <label>认证方式<select value={format} onChange={event => {
        const next = event.target.value as SecretFormat; setFormat(next);
        if (next === 'files' && !files.length) setFiles([{ path, content }]);
        if (next === 'text' && files.length) { setPath(files[0].path); setContent(files[0].content); }
      }}><option value="text">单文件</option><option value="files">文件组</option></select></label>
      {format === 'text' ? <>
      <label>认证文件路径<input required maxLength={256} value={path} onChange={event => setPath(event.target.value)} placeholder="例如 .my.cnf、.kube/config" /></label>
      <p>路径相对于工具运行的 HOME。内容按 UTF-8 文本原样使用，不做格式转换。</p>
      {editing !== 'new' && editing.requiresTextImport && <p className="connections-error">此密钥使用旧格式，请重新上传或粘贴原始文本认证文件。保存后生效。</p>}
      <label>上传文件<input type="file" onChange={e => void upload(e.target.files?.[0])} /></label>
      <label>认证内容<textarea required spellCheck={false} autoComplete="off" rows={12} value={content} onChange={e => setContent(e.target.value)} placeholder="粘贴工具原生认证文件的完整文本内容" /></label>
      </> : <>
        <p>路径相对于工具 HOME。第一份文件作为主配置；整组文件作为一个版本保存，总大小最多 512 KiB。</p>
        <label className="secret-checkbox"><input type="checkbox" checked={directoryMode} onChange={event => { setDirectoryMode(event.target.checked); if (!directory && files[0]?.path.includes('/')) setDirectory(files[0].path.slice(0, files[0].path.lastIndexOf('/'))); }} />凭证目录</label>
        {directoryMode && <>
          <label>凭证目录路径<input required value={directory} maxLength={256} onChange={event => {
            const next = event.target.value;
            setFiles(previous => previous.map(file => file.path.startsWith(directory + '/') ? { ...file, path: next + file.path.slice(directory.length) } : file)); setDirectory(next);
          }} placeholder="相对于工具 HOME，例如 .config/custom" /></label>
          <label>上传凭证目录<input type="file" multiple {...{ webkitdirectory: '', directory: '' }} onChange={event => void uploadDirectory(event.target.files)} /></label>
          <label>主配置文件<select value={files[0]?.path ?? ''} onChange={event => setFiles(previous => { const selected = previous.find(file => file.path === event.target.value); return selected ? [selected, ...previous.filter(file => file !== selected)] : previous; })}>{files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
          <p>保留子目录、文本和二进制文件。工具在该目录内新增或删除的文件会随整个目录回写。</p>
        </>}
        <label className="secret-checkbox"><input type="checkbox" checked={meegle} disabled={tool.trim() !== 'meegle'} onChange={event => {
          setMeegle(event.target.checked);
          if (event.target.checked) {
            setMutable(true);
          }
        }} />Meegle 原生加密凭证</label>
        {meegle && <>
          <label>来源 hostname<input required value={identity.hostname} maxLength={253} onChange={event => setIdentity(previous => ({ ...previous, hostname: event.target.value }))} /></label>
          <label>来源 USER<input required value={identity.username} maxLength={253} onChange={event => setIdentity(previous => ({ ...previous, username: event.target.value }))} /></label>
          <p>填写原凭证加密时的身份。文件落盘时按 Sandbox 身份重新加密；刷新仍由 Meegle CLI 完成。</p>
        </>}
        {files.map((file, index) => <fieldset key={index} className="secret-file-entry">
          <legend>文件 {index + 1}{index === 0 ? ' · 主配置' : ''}</legend>
          <label>文件路径<input required maxLength={256} value={file.path} onChange={event => setFiles(previous => previous.map((entry, i) => i === index ? { ...entry, path: event.target.value } : entry))} /></label>
          <label>上传文件<input type="file" onChange={event => void upload(event.target.files?.[0], index)} /></label>
          {file.encoding ? <p>二进制文件 · {atob(file.content).length} 字节，按原内容保存。</p> : <label>文件内容<textarea rows={5} spellCheck={false} autoComplete="off" value={file.content} onChange={event => setFiles(previous => previous.map((entry, i) => i === index ? { ...entry, content: event.target.value } : entry))} /></label>}
          <button type="button" className="secondary-button" disabled={busy || files.length === 1} onClick={() => setFiles(previous => previous.filter((_, i) => i !== index))}>移除文件 {index + 1}</button>
        </fieldset>)}
        <button type="button" className="secondary-button" disabled={busy || files.length >= 128} onClick={() => setFiles(previous => [...previous, { path: '', content: '' }])}>添加文件</button>
      </>}
      <label className="secret-checkbox"><input type="checkbox" checked={mutable} onChange={e => setMutable(e.target.checked)} />允许工具更新{format === 'files' ? '整组文件' : '此文件'}</label>
      <p>{format === 'files' ? '整组回写会检查基础版本，冲突时保留 Sandbox 本地文件并提示。' : '更新后最后保存的内容生效。'}凭证及更新历史加密存储。</p>
      <div className="secret-actions"><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存'}</button><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button></div>
    </form>}
    {loading ? <p role="status">正在读取 Secret…</p> : !items.length ? <div className="connections-empty">尚未创建 Secret。新建后，在项目的“工具权限”中绑定。</div> : <div className="secret-list">{items.map(item => <article className="connection-card" key={item.id}>
      <div className="connection-profile-title"><strong>{item.name}</strong><span>{item.enabled ? '启用' : '停用'}</span></div>
      <p>{item.tool ?? '待填写工具'} · {item.path ?? '待填写路径'} · {item.format === 'files' ? `${item.filePaths?.length ?? 0} 份文件` : 'text'} · v{item.version} · {item.mutable ? '工具可更新' : '管理员维护'} · {item.projectIds.length} 个项目{item.requiresTextImport && ' · 需重新导入文本'}</p>
      <p>最近更新 {new Date(item.updatedAt).toLocaleString()}</p>
      <div className="secret-actions"><button className="secondary-button" disabled={busy} onClick={() => void edit(item)}>编辑</button><button className="secondary-button" disabled={busy} onClick={async () => {
        setBusy(true); setError(''); try { await api(`/api/secrets/${item.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }) }); await refresh(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      }}>{item.enabled ? '停用' : '启用'}</button><button className="secondary-button" disabled={busy} onClick={async () => {
        setBusy(true); setError(''); try { setHistory({ id: item.id, name: item.name, rows: await api<SecretVersion[]>(`/api/secrets/${item.id}/versions`) }); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      }}>更新记录</button><button className="secondary-button" disabled={busy} onClick={() => void remove(item)}>删除</button></div>
    </article>)}</div>}
    {history && <section className="secret-form"><div className="secret-actions"><h2>{history.name} · 更新记录</h2><button className="secondary-button" onClick={() => setHistory(null)}>关闭</button></div><table><thead><tr><th>提交时间</th><th>来源</th><th>修改项</th><th>基础版本</th><th>项目</th></tr></thead><tbody>{history.rows.map(row => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString()}</td><td>{row.source === 'operator' ? '管理员' : '工具回写'}</td><td>{row.changes.join(', ')}</td><td>{row.baseVersion ?? '新建'}</td><td>{row.projectId ?? '—'}</td></tr>)}</tbody></table></section>}
  </>;
}
