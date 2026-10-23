import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { DynamicTool } from '../../../protocol/tool-types';
import type { ToolScript } from '../../../protocol/tool-script-types';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useDraftStatus } from './DraftGuard';
import EditorDialog from './EditorDialog';
import ScriptPreview from './ScriptPreview';
import { scriptUsages } from './tool-script-context';
import './ScriptManager.css';

type Language = ToolScript['language'];
type Editor = ToolScript | 'new' | null;
const scriptsChanged = () => window.dispatchEvent(new Event('cocell:tool-scripts-changed'));

export default function ScriptManager() {
  const [items, setItems] = useState<ToolScript[]>([]);
  const [tools, setTools] = useState<DynamicTool[] | null>(null);
  const [referenceError, setReferenceError] = useState('');
  const [preview, setPreview] = useState<ToolScript | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<Editor>(null);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<Language>('typescript');
  const [source, setSource] = useState('');
  const editorBaseline = useRef('');
  const referenceController = useRef<AbortController | null>(null);
  const editorDirty = editing !== null && JSON.stringify({ name, language, source }) !== editorBaseline.current;
  const draftGuard = useDraftStatus('script-editor', editorDirty, busy && editing !== null);

  async function refresh(signal?: AbortSignal) {
    const scripts = await api<ToolScript[]>('/api/tool-scripts', { signal });
    if (!signal?.aborted) setItems(scripts);
  }

  async function refreshReferences(signal: AbortSignal) {
    try {
      const definitions = await api<DynamicTool[]>('/api/tool-definitions', { signal });
      if (signal.aborted) return false;
      setTools(definitions);
      setReferenceError('');
      return true;
    } catch (err) {
      if (!signal.aborted) {
        setTools(null);
        setReferenceError(errorMessage(err));
      }
      return false;
    }
  }

  function loadReferences() {
    referenceController.current?.abort();
    const controller = new AbortController();
    referenceController.current = controller;
    return refreshReferences(controller.signal).finally(() => {
      if (referenceController.current === controller) referenceController.current = null;
    });
  }

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    void loadReferences();
    const changed = () => { void refresh(controller.signal).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }); };
    const catalogChanged = () => { void loadReferences(); };
    window.addEventListener('cocell:tool-scripts-changed', changed);
    window.addEventListener('cocell:tool-catalog-changed', catalogChanged);
    return () => {
      controller.abort(); referenceController.current?.abort(); referenceController.current = null;
      window.removeEventListener('cocell:tool-scripts-changed', changed);
      window.removeEventListener('cocell:tool-catalog-changed', catalogChanged);
    };
  }, []);

  const referencesKnown = tools !== null;
  const usagesFor = (scriptId: string) => referencesKnown ? scriptUsages(scriptId, tools ?? []) : [];
  function start(item?: ToolScript) {
    if (editing && draftGuard && !draftGuard.canLeave(['script-editor'])) return;
    const nextName = item?.name ?? '', nextLanguage = item?.language ?? 'typescript', nextSource = item?.source ?? '';
    editorBaseline.current = JSON.stringify({ name: nextName, language: nextLanguage, source: nextSource });
    setName(nextName); setLanguage(nextLanguage); setSource(nextSource);
    setEditing(item ?? 'new'); setError(''); setMessage('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || !name.trim() || !source.trim()) return;
    setBusy(true); setError(''); setMessage('');
    const creating = editing === 'new';
    const body = { name: name.trim(), language, source, ...(!creating ? { version: editing.version } : {}) };
    try {
      const saved = await api<ToolScript>(creating ? '/api/tool-scripts' : `/api/tool-scripts/${editing.id}`, {
        method: creating ? 'POST' : 'PUT', body: JSON.stringify(body),
      });
      setItems(current => [saved, ...current.filter(item => item.id !== saved.id)]);
      setEditing(null); scriptsChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && editing !== 'new') setError('脚本已被其他操作修改。当前草稿已保留；刷新列表后重新打开脚本，可读取最新版本。');
      else setError(errorMessage(err));
    } finally { setBusy(false); }
  }

  function closeEditor() {
    if (!busy && (!draftGuard || draftGuard.canLeave(['script-editor']))) setEditing(null);
  }

  async function remove(item: ToolScript) {
    if (!window.confirm(`删除共享脚本“${item.name}”？`)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/api/tool-scripts/${item.id}`, { method: 'DELETE', body: JSON.stringify({ version: item.version }) });
      setItems(current => current.filter(value => value.id !== item.id));
      setEditing(current => current === item ? null : current);
      scriptsChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError('脚本正在被工具引用或已更新。请刷新列表后重试。');
      else setError(errorMessage(err));
    } finally { setBusy(false); }
  }

  return <section className="tool-script-manager" aria-labelledby="tool-scripts-title">
    <div className="connections-heading"><div><h2 id="tool-scripts-title">脚本管理</h2><p>统一管理工具权限检查、Load hook 和 Save hook。</p></div>
      <div className="tool-manager-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setBusy(true); setError(''); setMessage(''); void (async () => {
        const [scriptResult, referenceResult] = await Promise.allSettled([refresh(), loadReferences()]);
        if (scriptResult.status === 'rejected') setError(errorMessage(scriptResult.reason));
        else setMessage(referenceResult.status === 'fulfilled' && referenceResult.value ? '脚本和工具引用已刷新。' : '脚本列表已刷新，工具引用未能读取。');
      })().finally(() => setBusy(false)); }}>刷新列表</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => start()}>新建脚本</button></div></div>
    {error && !editing && <p className="connections-error" role="alert">{error}</p>}{message && <p className="connections-message" role="status">{message}</p>}
    {editing && <EditorDialog title={editing === 'new' ? '新建脚本' : `编辑脚本：${editing.name}`} busy={busy} error={error} onClose={closeEditor}>
      <form className="secret-form tool-script-form" onSubmit={event => void save(event)}>
      <label>脚本名称<input aria-label="脚本名称" required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="例如只读查询权限检查" /></label>
      <label>语言<select aria-label="语言" value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="typescript">TypeScript</option><option value="bash">Bash</option></select></label>
      <label>脚本内容<textarea aria-label="脚本内容" required maxLength={16000} rows={14} spellCheck={false} value={source} onChange={event => setSource(event.target.value)} placeholder={language === 'bash' ? '# 从 stdin 读取 JSON，将结果写到 stdout' : '// 根据用途读取 input，返回检查或凭据处理结果'} /></label>
      <p className="tool-permission-help">Bash 从 stdin 读取 JSON；TypeScript 填写函数体，使用 input 和 codec，通过 return 返回结果。</p>
      <details className="tool-credential-settings"><summary>脚本输入与返回值</summary>
        <p>权限检查读取 input.args 和 input.permission，返回 true、false 或 {`{allow, reason}`}；命名凭据模式还必须返回 {`{allow: true, credential: "名称"}`}；Bash 将 JSON 结果写到 stdout。</p>
        <p>Load hook 读取 input.path、input.content（原文件 Base64）和 input.files（相关文件的 path、content）。可返回文本或 {`{content, encoding, names}`}；encoding 可为 utf8、base64 或 parsed（默认 parsed）。Bash 将显示文本或 JSON 写到 stdout。</p>
        <p>Save hook 配置后每次保存都会运行，读取 input.path、input.content（编辑文本）、input.encoding、input.original（原文件 Base64）和 input.files。TypeScript 可通过 codec.utf8.encode 返回规范文件 Base64。Bash 可将原始字节写到 stdout，或更新临时 HOME 中的暂存文件。</p>
      </details>
      {editing !== 'new' && <section className="script-edit-impact" aria-label="脚本修改影响">
        <h3>修改影响</h3>
        {!referencesKnown ? <p role="status">{referenceError ? `工具引用暂时不可用：${referenceError}` : '正在读取工具引用…'} 修改会影响所有引用此共享脚本的工具。</p> : (() => {
          const usages = usagesFor(editing.id);
          return usages.length ? <>
            <p>这是共享脚本。保存后会影响以下绑定它的工具；实际调用仍按各项目的工具角色授权。</p>
            <ul>{usages.map(({ tool, binding }) => <li key={`${tool.name}:${binding.field}`}>
              <strong>{tool.name}</strong><span>{binding.label}</span>
            </li>)}</ul>
          </> : <p>当前没有工具引用此脚本。</p>;
        })()}
      </section>}
      <div className="secret-actions"><button className="primary-button" disabled={busy || !name.trim() || !source.trim()}>{busy ? '保存中…' : '保存脚本'}</button><button type="button" className="secondary-button" disabled={busy} onClick={closeEditor}>取消</button></div>
      </form>
    </EditorDialog>}
    {preview && <ScriptPreview script={preview} tools={tools ?? []} referencesKnown={referencesKnown} onClose={() => setPreview(null)} />}
    {referenceError && <p className="script-reference-error" role="status">工具引用加载失败：{referenceError}。脚本使用情况与删除状态尚未确认。</p>}
    {loading ? <p role="status">正在读取脚本…</p> : items.length ? <div className="tool-script-list">{items.map(item => {
      const usages = usagesFor(item.id);
      return <article className="connection-card" key={item.id} aria-label={item.name}>
      <div className="connection-profile-title"><strong>{item.name}</strong><span>{item.language === 'bash' ? 'Bash' : 'TypeScript'} · v{item.version}</span></div>
      <p>更新于 {new Date(item.updatedAt).toLocaleString()}</p>
      <div className="script-usage">
        <strong>使用位置</strong>
        {!referencesKnown ? <span className="script-usage-unknown">引用信息未加载，暂无法确认使用位置。</span> : usages.length ? <div className="script-usage-list">{usages.map(({ tool, binding }) => <div className="script-usage-item" key={`${tool.name}:${binding.field}`}>
          <span className={`script-usage-chip${tool.enabled ? '' : ' is-disabled'}`}>{tool.name} · {binding.label}{!tool.enabled && ' · 工具已停用'}</span>
          <small><strong>{binding.trigger}</strong> · {binding.description}</small>
        </div>)}</div> : <span>未被工具引用</span>}
      </div>
      <div className="secret-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setPreview(item)}>查看脚本</button><button type="button" className="secondary-button" disabled={busy} onClick={() => start(item)}>编辑</button><button type="button" className="secondary-button" disabled={busy || !referencesKnown || usages.length > 0} title={!referencesKnown ? '工具引用尚未加载，无法确认是否可以删除' : usages.length ? '仍有工具引用此脚本，不能删除' : undefined} onClick={() => void remove(item)}>删除</button></div>
    </article>})}</div> : <div className="connections-empty">暂无共享脚本。创建脚本后，可在工具设置中引用。</div>}
  </section>;
}
