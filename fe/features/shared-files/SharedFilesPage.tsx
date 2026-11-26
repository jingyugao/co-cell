import { useEffect, useRef, useState } from 'react';
import './SharedFilesPage.css';

type SharedFile = { path: string; size: number; updatedAt: string; editable: boolean; version: string };
type FileContent = { path: string; content: string; version: string };
type Props = { profileId: string; onDirtyChange: (dirty:boolean)=>void; onSaved:()=>Promise<void>; onDeleteSkill:(name:string)=>Promise<void> };
const MAX_BYTES = 1024 * 1024;
class FileRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function request<T>(url: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method, signal,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new FileRequestError(result.error || `操作失败 (${response.status})`, response.status);
  return result as T;
}
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < MAX_BYTES ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / MAX_BYTES).toFixed(1)} MB`;
const sandboxPath = (path: string) => path === 'AGENTS.md' ? '~/.codex/AGENTS.md' : `~/.codex/${path}`;

export default function SharedFilesPage({ profileId, onDirtyChange, onSaved, onDeleteSkill }: Props) {
  const base = `/api/agents/${profileId}/files`;
  const listFiles = (signal?: AbortSignal) => request<{ files: SharedFile[] }>(base, 'GET', undefined, signal);
  const readFile = (file: SharedFile, signal?: AbortSignal): Promise<FileContent> => file.editable
    ? request(`${base}/content?path=${encodeURIComponent(file.path)}`, 'GET', undefined, signal)
    : Promise.resolve({ path: file.path, content: '', version: file.version });

  const [files, setFiles] = useState<SharedFile[]>([]);
  const [selected, setSelected] = useState<SharedFile | null>(null);
  const [creating, setCreating] = useState(false);
  const [skillDraft,setSkillDraft] = useState(false), [skillDescription,setSkillDescription] = useState('');
  const [newPath, setNewPath] = useState('docs/');
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [version, setVersion] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pathInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const dirty = creating ? newPath !== 'docs/' || content !== '' : content !== original;
  const contentBytes = new TextEncoder().encode(content).byteLength;
  const selectedSkill = selected?.path.startsWith('skills/') ? selected.path.split('/')[1] : undefined;
  const canSave = !busy && (creating || selected?.editable) && (creating || dirty) && contentBytes <= MAX_BYTES && (!creating || newPath.trim().length > 0);
  const visible = files.filter(file => file.path.toLowerCase().includes(query.trim().toLowerCase()));

  function applySelection(file: SharedFile | null, loaded?: FileContent) {
    setSelected(file); setCreating(false); setSkillDraft(false); setContent(loaded?.content ?? ''); setOriginal(loaded?.content ?? '');
    setVersion(loaded?.version ?? ''); setConfirmDelete(false); setConflict(false); setMessage('');
  }
  function handleError(err: unknown) {
    if (!alive.current) return;
    setError(err instanceof Error ? err.message : '操作失败，请重试。');
    setConflict(err instanceof FileRequestError && err.status === 409);
  }
  function allowDiscard() {
    return !dirty || window.confirm('有未保存的修改，确定放弃这些修改吗？');
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await listFiles(controller.signal);
        if (controller.signal.aborted) return;
        setFiles(result.files);
        const first = result.files.find(file => file.path === 'AGENTS.md') ?? result.files[0];
        const loaded = first ? await readFile(first, controller.signal) : undefined;
        if (!controller.signal.aborted) applySelection(first ?? null, loaded);
      } catch (err) { if (!controller.signal.aborted) handleError(err); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    })();
    return () => { alive.current = false; controller.abort(); };
  }, []);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => { if (creating) pathInput.current?.focus(); }, [creating]);
  useEffect(() => { if (confirmDelete) cancelDelete.current?.focus(); }, [confirmDelete]);

  async function openFile(file: SharedFile) {
    if (busy || (!creating && selected?.path === file.path) || !allowDiscard()) return;
    setBusy(true); setError('');
    try { const loaded = await readFile(file); if (alive.current) applySelection(file, loaded); }
    catch (err) { handleError(err); }
    finally { if (alive.current) setBusy(false); }
  }
  async function refresh() {
    if (busy || !allowDiscard()) return;
    setBusy(true); setError('');
    try {
      const [result] = await Promise.all([listFiles(), onSaved()]);
      const next = result.files.find(file => file.path === (creating ? newPath.trim() : selected?.path)) ?? result.files.find(file => file.path === 'AGENTS.md') ?? result.files[0];
      const loaded = next ? await readFile(next) : undefined;
      if (alive.current) { setFiles(result.files); applySelection(next ?? null, loaded); }
    } catch (err) { handleError(err); }
    finally { if (alive.current) setBusy(false); }
  }
  function startNew(path = 'docs/', skill = false) {
    if (busy || !allowDiscard()) return;
    applySelection(null); setCreating(true); setNewPath(path); setSkillDraft(skill); setSkillDescription(''); setError('');
  }
  async function save() {
    if (!canSave) return;
    const path = creating ? newPath.trim() : selected!.path;
    if (skillDraft && (!/^skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md$/.test(path) || !skillDescription.trim())) { setError('请输入 skill 名称和说明'); return; }
    const bytes = skillDraft ? ['---','name: '+path.split('/')[1],'description: '+JSON.stringify(skillDescription.trim()),'---','',content].join('\n') : content;
    setBusy(true); setError(''); setConflict(false); setMessage('');
    try {
      const saved = await request<FileContent>(base, creating ? 'POST' : 'PUT', { path, content:bytes, ...(!creating ? { version } : {}) });
      if (!alive.current) return;
      const file = { path: saved.path, size: new TextEncoder().encode(saved.content).byteLength, updatedAt: new Date().toISOString(), editable: true, version: saved.version };
      applySelection(file, saved);
      setFiles(previous => [...previous.filter(item => item.path !== file.path), file].sort((a, b) => a.path.localeCompare(b.path)));
      setMessage(`已保存 ${saved.path}，可在项目页应用最新配置。`);
      await onSaved();
      try { const result = await listFiles(); if (alive.current) setFiles(result.files); }
      catch { if (alive.current) setMessage(`已保存 ${saved.path}，列表暂未刷新。可在项目页应用最新配置。`); }
    } catch (err) { handleError(err); }
    finally { if (alive.current) setBusy(false); }
  }
  async function deleteFile() {
    if (busy || !selected) return;
    const path = selected.path;
    setBusy(true); setError(''); setConflict(false); setMessage('');
    try {
      if (selectedSkill && path === 'skills/'+selectedSkill+'/SKILL.md') { await onDeleteSkill(selectedSkill); return; }
      await request(base, 'DELETE', { path, version });
      await onSaved();
      if (!alive.current) return;
      setFiles(previous => previous.filter(file => file.path !== path));
      applySelection(null);
      setMessage(`已删除 ${path}，可在项目页应用最新配置。`);
    } catch (err) { handleError(err); }
    finally { if (alive.current) { setBusy(false); setConfirmDelete(false); } }
  }

  return <section aria-label="Agent 配置文件" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
  }}>
      <div className="agent-toolbar"><h2>规则与 skills</h2>
        <button className="secondary-button" disabled={busy} onClick={()=>startNew('skills//SKILL.md',true)}>新建 skill</button>
        <button className="secondary-button" disabled={busy} onClick={()=>startNew()}>新建文件</button>
      </div>
      {error && <div className="shared-files-error" role="alert"><span>{error}</span>{conflict && <div><p>文件已发生变化，当前草稿仍保留。重新加载会读取最新版本，并提示放弃未保存的修改。</p><button className="secondary-button" disabled={busy} onClick={() => void refresh()}>重新加载最新版本</button></div>}</div>}
      {message && <p className="shared-files-message" role="status">{message}</p>}
      <div className="shared-files-workspace">
        <aside className="shared-files-browser" aria-label="Agent 文件列表">
          <div className="shared-files-browser-heading"><strong>文件 <span>{files.length}</span></strong><button className="secondary-button" disabled={busy} onClick={() => void refresh()} aria-label="刷新Agent 文件">{busy ? '读取中…' : '刷新'}</button></div>
          <input className="shared-files-search" type="search" aria-label="搜索Agent 文件" placeholder="搜索文件路径" value={query} onChange={event => setQuery(event.target.value)} />
          <nav className="shared-files-list" aria-label="选择Agent 文件">
            {!visible.length && <p className="shared-files-no-results">{busy && !files.length ? '正在读取文件…' : files.length ? '没有匹配的文件' : '还没有文件，点击新建开始。'}</p>}
            {visible.map(file => <button key={file.path} className={`shared-file-row ${!creating && selected?.path === file.path ? 'selected' : ''}`} aria-current={!creating && selected?.path === file.path ? 'page' : undefined} disabled={busy} onClick={() => void openFile(file)} title={file.path}>
              <span className="shared-file-symbol" aria-hidden="true">{file.path === 'AGENTS.md' ? '◎' : '≡'}</span><span className="shared-file-row-info"><strong>{file.path}</strong><small>{sizeLabel(file.size)}{!file.editable && ' · 仅可删除'}</small></span>
            </button>)}
          </nav>
          <p className="shared-files-help"><code>AGENTS.md</code> 定义此 Agent 的规则。<br /><code>docs/</code> 存放参考文档，可创建子目录。<code>skills/</code> 存放技能包。</p>
        </aside>
        <section className="shared-file-editor" aria-label="文件编辑器" aria-busy={busy}>
          {creating || selected ? <>
            <div className="shared-file-editor-heading"><div><span>{creating ? '新建文件' : selected?.path === 'AGENTS.md' ? 'Agent 规则' : '配置文件'}</span><h2>{creating ? '编写新文档' : selected?.path}</h2></div><div className="shared-file-actions">{dirty && <span className="shared-file-dirty">未保存</span>}{!creating && <button className="shared-file-delete" disabled={busy || confirmDelete} onClick={() => { setConfirmDelete(true); setError(''); }}>删除</button>}{(creating || selected?.editable) && <button className="primary-button" disabled={!canSave} onClick={() => void save()}>{busy ? '处理中…' : creating ? '创建文件' : '保存修改'}</button>}</div></div>
            {creating && skillDraft ? <div className="agent-config-form"><label>Skill 名称<input ref={pathInput} value={newPath.split('/')[1]} onChange={e=>setNewPath('skills/'+e.target.value+'/SKILL.md')} placeholder="code-review"/></label><label>Skill 说明<input value={skillDescription} onChange={e=>setSkillDescription(e.target.value)} placeholder="说明这个 skill 适用于哪些任务"/></label></div> : creating ? <label className="shared-file-path-label">文件路径<input ref={pathInput} value={newPath} disabled={busy} placeholder="skills/code-review/SKILL.md" onChange={event => { setNewPath(event.target.value); setMessage(''); }} /><small>支持 AGENTS.md、docs/ 和 skills/名称/ 下的文件。每个 skill 需要 SKILL.md。</small></label> : <div className="shared-file-location"><span>配置 <code>{selected?.path}</code></span><span>沙箱 <code>{sandboxPath(selected!.path)}</code></span></div>}
            {confirmDelete && <div className="shared-file-delete-confirm" role="group" aria-label="确认删除Agent 文件" onKeyDown={event => { if (event.key === 'Escape' && !busy) setConfirmDelete(false); }}><strong>{selectedSkill && selected?.path === 'skills/'+selectedSkill+'/SKILL.md' ? '删除整个 skill「'+selectedSkill+'」及其文件？' : '删除 '+selected?.path+'？'}</strong><p>应用新版配置后，项目将移除此项。</p><div><button ref={cancelDelete} className="secondary-button" disabled={busy} onClick={() => setConfirmDelete(false)}>保留文件</button><button className="shared-file-danger" disabled={busy} onClick={() => void deleteFile()}>确认删除</button></div></div>}
            {creating || selected?.editable ? <><label className="shared-file-content-label" htmlFor="shared-file-content">文件内容 <span>UTF-8 文本 · Ctrl / ⌘ + S 保存</span></label><textarea id="shared-file-content" className="shared-file-content" value={content} disabled={busy} spellCheck={false} placeholder="在这里编写规则或参考文档…" onChange={event => { setContent(event.target.value); setMessage(''); }} /><div className={`shared-file-editor-footer ${contentBytes > MAX_BYTES ? 'over-limit' : ''}`}><span>{contentBytes > MAX_BYTES ? '内容超过 1 MB，请精简后再保存。' : '保存后，可在项目页应用最新配置。'}</span><span>{sizeLabel(contentBytes)} / 1 MB</span></div></> : <div className="shared-file-readonly"><span aria-hidden="true">≡</span><h3>此文件不支持在线编辑</h3><p>编辑器支持不超过 1 MB 的 UTF-8 文本。该文件仍会同步到沙箱，可以在此删除。</p><p>大小 {sizeLabel(selected!.size)}</p></div>}
          </> : <div className="shared-file-empty"><span aria-hidden="true">≡</span><h2>选择一个文件开始编辑</h2><button className="primary-button" disabled={busy} onClick={()=>startNew()}>新建文件</button></div>}
        </section>
      </div>
  </section>;
}
