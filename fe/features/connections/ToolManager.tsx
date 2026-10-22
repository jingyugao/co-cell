import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { DynamicTool, DynamicToolCreateInput, DynamicToolInput } from '../../../protocol/tool-types';
import type { ToolScript } from '../../../protocol/tool-script-types';
import type { ToolCatalogEntry } from '../../../protocol/secret-types';
import { TOOL_NAME_PATTERN } from '../../../util/tool-secrets';
import { api, errorMessage } from '../../lib/api';
import ToolCredentialBrowser from './ToolCredentialBrowser';
import EditorDialog from './EditorDialog';
import { useDraftStatus } from './DraftGuard';
import './ToolManager.css';

type Editor = DynamicTool | 'new' | null;
type Draft = Pick<DynamicToolInput, 'name' | 'enabled' | 'permissionScriptId' | 'credentialParseScriptId' | 'credentialSaveScriptId'>;

const blank: Draft = { name: '', enabled: true, permissionScriptId: '', credentialParseScriptId: '', credentialSaveScriptId: '' };
const catalogChanged = () => window.dispatchEvent(new Event('cocell:tool-catalog-changed'));

function readJson<T>(value: string, expected: string): T {
  try { return JSON.parse(value) as T; }
  catch { throw new Error(`${expected} 必须是有效 JSON`); }
}

export default function ToolManager() {
  const [items, setItems] = useState<DynamicTool[]>([]);
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
  const [scripts, setScripts] = useState<ToolScript[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [editing, setEditing] = useState<Editor>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [argsText, setArgsText] = useState('[]');
  const [credentialPathsText, setCredentialPathsText] = useState('');
  const [embeddedCredentialOpen, setEmbeddedCredentialOpen] = useState(false);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const editorBaseline = useRef('');
  const editorDirty = editing !== null && JSON.stringify({ draft, argsText, credentialPathsText }) !== editorBaseline.current;
  const draftGuard = useDraftStatus('tool-editor', editorDirty, busy && editing !== null);

  const tools = useMemo(() => [...new Set([...catalog.map(item => item.name), ...items.map(item => item.name)])].sort(), [catalog, items]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<DynamicTool[]>('/api/tool-definitions', { signal: controller.signal }),
      api<ToolCatalogEntry[]>('/api/tools', { signal: controller.signal }),
      api<ToolScript[]>('/api/tool-scripts', { signal: controller.signal }),
    ]).then(([definitions, entries, availableScripts]) => {
      if (!controller.signal.aborted) { setItems(definitions); setCatalog(entries); setScripts(availableScripts); }
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const scriptListChanged = () => {
      void api<ToolScript[]>('/api/tool-scripts').then(setScripts).catch(err => setError(errorMessage(err)));
    };
    const toolListChanged = () => {
      void api<ToolCatalogEntry[]>('/api/tools', { signal: controller.signal }).then(setCatalog)
        .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    };
    window.addEventListener('cocell:tool-scripts-changed', scriptListChanged);
    window.addEventListener('cocell:tool-catalog-changed', toolListChanged);
    return () => { controller.abort(); window.removeEventListener('cocell:tool-scripts-changed', scriptListChanged); window.removeEventListener('cocell:tool-catalog-changed', toolListChanged); };
  }, []);

  async function reload() {
    setBusy(true); setError(''); setMessage('');
    try {
      const [definitions, entries] = await Promise.all([api<DynamicTool[]>('/api/tool-definitions'), api<ToolCatalogEntry[]>('/api/tools')]);
      setItems(definitions); setCatalog(entries);
      if (editing && editing !== 'new') {
        const latest = definitions.find(item => item.name === editing.name);
        if (!latest || latest.version !== editing.version) {
          setMessage('工具已被其他操作修改。当前草稿已保留；取消编辑后重新打开工具，可读取最新配置。');
          return;
        }
      }
      setMessage('工具目录已刷新。当前编辑内容已保留。');
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }

  function start(item?: DynamicTool) {
    if (draftGuard && !draftGuard.canLeave(['tool-editor', 'credential-browser'])) return;
    setBrowsing(null);
    setEmbeddedCredentialOpen(Boolean(item));
    const nextDraft = item ? { name: item.name, enabled: item.enabled, permissionScriptId: item.permissionScriptId ?? '', credentialParseScriptId: item.credentialParseScriptId ?? '', credentialSaveScriptId: item.credentialSaveScriptId ?? '' } : { ...blank };
    const nextArgs = JSON.stringify(item?.args ?? [], null, 2);
    const nextPaths = (item?.credentialPaths ?? []).join('\n');
    editorBaseline.current = JSON.stringify({ draft: nextDraft, argsText: nextArgs, credentialPathsText: nextPaths });
    setDraft(nextDraft);
    setArgsText(nextArgs);
    setCredentialPathsText(nextPaths);
    setError(''); setMessage(''); setEditing(item ?? 'new');
  }

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  function closeEditor() {
    if (!busy && (!draftGuard || draftGuard.canLeave(['tool-editor', 'credential-browser']))) {
      setEmbeddedCredentialOpen(false);
      setEditing(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (draftGuard && !draftGuard.canLeave(['credential-browser'])) return;
    setEmbeddedCredentialOpen(false);
    setBusy(true); setError(''); setMessage('');
    try {
      const args = readJson<unknown>(argsText, '启动参数');
      if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('启动参数必须是字符串数组');
      const credentialPaths = credentialPathsText.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
      if (!editing) return;
      const creating = editing === 'new';
      const changes: DynamicToolCreateInput = {
        name: draft.name.trim(), enabled: draft.enabled,
        ...(!creating || args.length ? { args } : {}),
        ...(credentialPaths.length ? { credentialPaths } : {}),
        ...(draft.permissionScriptId ? { permissionScriptId: draft.permissionScriptId } : {}),
        ...(draft.credentialParseScriptId ? { credentialParseScriptId: draft.credentialParseScriptId } : {}),
        ...(draft.credentialSaveScriptId ? { credentialSaveScriptId: draft.credentialSaveScriptId } : {}),
      };
      let body: object = changes;
      if (!creating) {
        const { version, createdAt: _createdAt, updatedAt: _updatedAt, permissionScript: _legacyPermissionScript, ...settings } = editing as DynamicTool;
        body = { ...settings, ...changes,
          credentialPaths,
          permissionScriptId: draft.permissionScriptId || null,
          credentialParseScriptId: draft.credentialParseScriptId || null,
          credentialSaveScriptId: draft.credentialSaveScriptId || null,
          version };
      }
      const saved = await api<DynamicTool>(creating ? '/api/tool-definitions' : `/api/tool-definitions/${encodeURIComponent(draft.name)}`, {
        method: creating ? 'POST' : 'PUT',
        body: JSON.stringify(body),
      });
      setItems(current => [saved, ...current.filter(item => item.name !== saved.name)]);
      setEditing(null); catalogChanged();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); setEmbeddedCredentialOpen(true); }
  }

  async function remove(item: DynamicTool) {
    if (!window.confirm(`删除工具 ${item.name}？`)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/api/tool-definitions/${encodeURIComponent(item.name)}`, { method: 'DELETE', body: JSON.stringify({ version: item.version }) });
      setItems(current => current.filter(value => value.name !== item.name)); catalogChanged();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }

  function toggleBrowser(name: string) {
    if (draftGuard && !draftGuard.canLeave(['tool-editor', 'credential-browser'])) return;
    setBrowsing(current => current === name ? null : name);
  }

  return <section className="tool-manager" aria-labelledby="dynamic-tools-title">
    <div className="connections-heading"><div><h2 id="dynamic-tools-title">工具管理</h2><p>通过 cocell &lt;工具名&gt; 调用，权限修改在下次调用时生效。</p></div>
      <div className="tool-manager-actions"><button className="secondary-button" disabled={busy} onClick={() => void reload()}>刷新目录</button><button className="primary-button" disabled={busy} onClick={() => start()}>添加工具</button></div></div>
    {error && !editing && <p className="connections-error" role="alert">{error}</p>}{message && <p className="connections-message" role="status">{message}</p>}
    {editing && <EditorDialog title={editing === 'new' ? '添加工具' : `编辑工具：${editing.name}`} busy={busy} error={error} onClose={closeEditor}>
      <form className="secret-form tool-definition-form" onSubmit={event => void save(event)}>
      <div className="tool-form-grid">
        <label>工具名<input required maxLength={64} pattern={TOOL_NAME_PATTERN.source} value={draft.name} disabled={editing !== 'new'} onChange={event => setField('name', event.target.value)} placeholder="例如 acme" /></label>
        <label className="tool-enabled"><input type="checkbox" checked={draft.enabled} onChange={event => setField('enabled', event.target.checked)} />启用</label>
      </div>
      <label>启动参数（JSON 字符串数组）<textarea aria-label="启动参数（JSON 字符串数组）" className="tool-json" rows={3} spellCheck={false} value={argsText} onChange={event => setArgsText(event.target.value)} /></label>
      <label>权限检查脚本<select aria-label="权限检查脚本" value={draft.permissionScriptId ?? ''} onChange={event => setField('permissionScriptId', event.target.value)}>
        <option value="">不使用权限脚本</option>{draft.permissionScriptId && !scripts.some(script => script.id === draft.permissionScriptId) && <option value={draft.permissionScriptId}>已删除的脚本（清除引用）</option>}
        {scripts.map(script => <option key={script.id} value={script.id}>{script.name} · {script.language === 'bash' ? 'Bash' : 'TypeScript'}</option>)}
      </select></label>
      <p className="tool-permission-help">权限脚本读取 input.args 和 input.permission，返回允许或拒绝结果；项目角色授权始终生效。</p>
      <details className="tool-credential-settings">
        <summary>凭据配置</summary>
        <label>凭据文件或目录（相对 debug HOME，每行一个）<textarea aria-label="凭据文件或目录" rows={3} spellCheck={false} value={credentialPathsText} onChange={event => setCredentialPathsText(event.target.value)} placeholder="例如 .mylogin.cnf 或 .config/tool" /></label>
        <label>Load hook<select aria-label="Load hook" value={draft.credentialParseScriptId ?? ''} onChange={event => setField('credentialParseScriptId', event.target.value)}>
          <option value="">不使用 Load hook</option>{draft.credentialParseScriptId && !scripts.some(script => script.id === draft.credentialParseScriptId) && <option value={draft.credentialParseScriptId}>已删除的脚本（清除引用）</option>}
          {scripts.map(script => <option key={script.id} value={script.id}>{script.name} · {script.language === 'bash' ? 'Bash' : 'TypeScript'}</option>)}
        </select></label>
        <label>Save hook<select aria-label="Save hook" value={draft.credentialSaveScriptId ?? ''} onChange={event => setField('credentialSaveScriptId', event.target.value)}>
          <option value="">不使用 Save hook</option>{draft.credentialSaveScriptId && !scripts.some(script => script.id === draft.credentialSaveScriptId) && <option value={draft.credentialSaveScriptId}>已删除的脚本（清除引用）</option>}
          {scripts.map(script => <option key={script.id} value={script.id}>{script.name} · {script.language === 'bash' ? 'Bash' : 'TypeScript'}</option>)}
        </select></label>
        <p className="tool-permission-help">Load hook 读取 path、content（原文件 Base64）和 files，可返回文本或 {'{content, encoding, names}'}；encoding 可为 utf8、base64 或 parsed（默认 parsed）。</p>
        <p className="tool-permission-help">凭据 hook 还可读取 tool、primaryPath；加密工具可读取 identity 和 targetIdentity。TypeScript 可用 codec.yaml.parse 解析 YAML。</p>
        <p className="tool-permission-help">Save hook 配置后每次保存都会运行，输入 path、编辑后的 content、encoding、original（原文件 Base64）和 files。TypeScript 返回规范文件 Base64；Bash 可将原始字节写到 stdout，或更新临时 HOME 中的暂存文件。</p>
        {editing === 'new' ? <p className="tool-permission-help">保存工具后，可在这里浏览并编辑其凭据文件。</p> : embeddedCredentialOpen && editing && <ToolCredentialBrowser key={`editor-${editing.name}`} tool={editing.name} embedded onClose={() => setEmbeddedCredentialOpen(false)} />}
      </details>
      <div className="secret-actions"><button className="primary-button" disabled={busy || !draft.name.trim()}>{busy ? '保存中…' : '保存工具'}</button><button type="button" className="secondary-button" disabled={busy} onClick={closeEditor}>取消</button></div>
      </form>
    </EditorDialog>}
    {loading ? <p role="status">正在读取工具目录…</p> : !tools.length ? <div className="connections-empty">工具目录为空。</div> : <div className="secret-list tool-definition-list">{tools.map(name => {
      const item = items.find(value => value.name === name);
      const entry = catalog.find(value => value.name === name);
      return <article className="connection-card" key={name}>
        <div className="connection-profile-title"><strong>{name}</strong><span>{item ? (item.enabled ? '启用' : '停用') : '内置工具'}</span></div>
        {entry?.kind === 'tool-with-credential' && <p className="tool-credential-summary">连接：{entry.credentials.length ? entry.credentials.join('、') : '暂无已登记连接'}</p>}
        <div className="secret-actions"><button className="secondary-button" disabled={busy || !item} onClick={() => item && start(item)}>编辑</button>{item && <button className="secondary-button" disabled={busy} onClick={() => void remove(item)}>删除</button>}
          <button className="secondary-button" disabled={busy} onClick={() => toggleBrowser(name)}>{browsing === name ? '收起凭据' : '查看凭据'}</button></div>
        {browsing === name && <ToolCredentialBrowser key={name} tool={name} onClose={() => setBrowsing(null)} />}
      </article>;
    })}</div>}
  </section>;
}
