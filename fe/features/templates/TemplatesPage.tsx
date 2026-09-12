import { useEffect, useRef, useState } from 'react';
import type { TemplateBuild, TemplateDefinition, TemplateInventory, TemplateManifest } from '../../../shared/template-types';
import initialManifest from '../../../scripts/e2b/toolchains.json';
import './TemplatesPage.css';

type Props = { onMenu: () => void; onBack: () => void; onDirtyChange?: (dirty: boolean) => void; onDefaultChanged?: () => void };
type Draft = { name: string; manifest: TemplateManifest; go: string; node: string; python: string; systemPackages: string; extraMiseTools: string };
const languages = [{ key: 'go', label: 'Go', manager: 'mise' }, { key: 'node', label: 'Node.js', manager: 'mise' }, { key: 'python', label: 'Python', manager: 'uv' }] as const;
const defaultPhp = {
  version: '8.0.30' as const,
  composer: { version: '2.10.3', sha256: '7a2d379d5b8ffdaa028580ef26494c36d2feef4b178d3dd1473a4dbc5e17c8d6' },
};
const statusLabels: Record<TemplateBuild['status'], string> = { building: '构建中', verifying: '验证中', succeeded: '验证通过', failed: '失败', interrupted: '已中断' };
const isRunning = (build: TemplateBuild) => build.status === 'building' || build.status === 'verifying';
const splitList = (value: string) => [...new Set(value.split(/[\s,，]+/).map(item => item.trim()).filter(Boolean))];
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
function draftFor(name: string, manifest: TemplateManifest): Draft {
  return { name, manifest: structuredClone(manifest), go: manifest.go.join(', '), node: manifest.node.join(', '), python: manifest.python.join(', '), systemPackages: manifest.systemPackages.join('\n'), extraMiseTools: manifest.extraMiseTools.join('\n') };
}
function manifestFor(draft: Draft): TemplateManifest {
  return { ...draft.manifest, template: draft.manifest.template.trim(), go: splitList(draft.go), node: splitList(draft.node), python: splitList(draft.python), systemPackages: splitList(draft.systemPackages), extraMiseTools: splitList(draft.extraMiseTools) };
}
class TemplateRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function request<T>(url: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method, signal, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new TemplateRequestError(result.error || `操作失败 (${response.status})`, response.status);
  return result as T;
}

export default function TemplatesPage({ onMenu, onBack, onDirtyChange, onDefaultChanged }: Props) {
  const [inventory, setInventory] = useState<TemplateInventory | null>(null);
  const [selected, setSelected] = useState<TemplateDefinition | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [original, setOriginal] = useState('');
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
  const [buildDetails, setBuildDetails] = useState<TemplateBuild | null>(null);
  const [logError, setLogError] = useState('');
  const [followLogs, setFollowLogs] = useState(true);
  const alive = useRef(true);
  const inventoryEpoch = useRef(0);
  const logPane = useRef<HTMLPreElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const dirty = draft !== null && (creating || JSON.stringify(draft) !== original);
  const visible = inventory?.templates.filter(item => `${item.name} ${item.manifest.template}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const builds = inventory?.builds.filter(build => build.templateId === selected?.id) ?? [];
  const currentBuild = buildDetails?.id === selectedBuildId ? buildDetails : inventory?.builds.find(build => build.id === selectedBuildId);
  const activeBuild = inventory?.builds.find(build => build.id === inventory.activeBuildId);
  const isDefault = (id: string) => inventory?.templates.some(item => item.id === id && item.manifest.template === inventory.defaultTemplate) || inventory?.builds.some(build => build.templateId === id && build.reference === inventory.defaultTemplate && build.status === 'succeeded');
  const deleteBlocked = !!selected && (isDefault(selected.id) || inventory?.builds.some(build => build.templateId === selected.id && isRunning(build)));

  function applySelection(item: TemplateDefinition | null, nextBuilds = inventory?.builds ?? []) {
    const next = item ? draftFor(item.name, item.manifest) : null;
    setSelected(item); setDraft(next); setOriginal(JSON.stringify(next)); setCreating(false); setConfirmDelete(false); setConflict(false);
    setSelectedBuildId(nextBuilds.find(build => build.templateId === item?.id)?.id ?? null); setBuildDetails(null); setLogError('');
  }
  function handleError(err: unknown) {
    if (!alive.current) return;
    setError(err instanceof Error ? err.message : '操作失败，请重试。');
    setConflict(err instanceof TemplateRequestError && err.status === 409);
  }
  function allowDiscard() { return !dirty || window.confirm('模板有未保存的修改，确定放弃这些修改吗？'); }
  async function loadInventory(signal?: AbortSignal): Promise<TemplateInventory | null> {
    const epoch = ++inventoryEpoch.current;
    const next = await request<TemplateInventory>('/api/templates', 'GET', undefined, signal);
    if (!alive.current || signal?.aborted || epoch !== inventoryEpoch.current) return null;
    setInventory(next); return next;
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void loadInventory(controller.signal).then(next => { if (next) applySelection(next.templates[0] ?? null, next.builds); }).catch(err => { if (!controller.signal.aborted) handleError(err); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
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
  useEffect(() => { if (creating) nameInput.current?.focus(); }, [creating]);
  useEffect(() => { if (confirmDelete) cancelDelete.current?.focus(); }, [confirmDelete]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await loadInventory(controller.signal); }
      catch { /* Keep the last inventory and editable draft during transient failures. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), inventory?.activeBuildId ? 1800 : 8000);
    };
    timer = setTimeout(() => void poll(), inventory?.activeBuildId ? 1800 : 8000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [inventory?.activeBuildId]);
  useEffect(() => {
    setBuildDetails(null); setLogError(''); setFollowLogs(true);
    if (!selectedBuildId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<TemplateBuild>(`/api/template-builds/${encodeURIComponent(selectedBuildId)}`, 'GET', undefined, controller.signal);
        if (controller.signal.aborted) return;
        setBuildDetails(next); setLogError('');
        if (isRunning(next)) timer = setTimeout(() => void poll(), 1500);
      } catch (err) {
        if (controller.signal.aborted) return;
        setLogError(err instanceof Error ? err.message : '日志读取失败。');
        timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selectedBuildId]);
  useEffect(() => {
    if (followLogs && logPane.current) logPane.current.scrollTop = logPane.current.scrollHeight;
  }, [currentBuild?.logs, followLogs]);

  function changeDraft(values: Partial<Draft>) { setDraft(current => current && { ...current, ...values }); setMessage(''); }
  function changeManifest(values: Partial<TemplateManifest>) { setDraft(current => current && { ...current, manifest: { ...current.manifest, ...values } }); setMessage(''); }
  function select(item: TemplateDefinition) {
    if (busy || (!creating && selected?.id === item.id) || !allowDiscard()) return;
    applySelection(item); setError(''); setMessage('');
  }
  function startNew(copy = false) {
    if (busy || loading || !allowDiscard()) return;
    const source = copy && selected ? selected.manifest : initialManifest;
    const php = source.php;
    if (php && php.version !== '8.0.30') {
      setError('模板配置中的 PHP 版本不受支持，当前仅支持 8.0.30。'); return;
    }
    const manifest: TemplateManifest = {
      ...source, template: copy ? `${source.template.slice(0, 40)}-copy` : 'codex-custom',
      php: php ? { ...php, version: defaultPhp.version } : undefined,
    };
    const next = draftFor(copy && selected ? `${selected.name} 副本` : '新开发模板', manifest);
    applySelection(null); setDraft(next); setOriginal(''); setCreating(true); setError(''); setMessage('');
  }
  async function refresh() {
    if (busy || !allowDiscard()) return;
    setBusy(true); setError('');
    try { const next = await loadInventory(); if (next) { applySelection(next.templates.find(item => item.id === selected?.id) ?? next.templates[0] ?? null, next.builds); setMessage('已读取最新配置。'); } }
    catch (err) { handleError(err); }
    finally { if (alive.current) setBusy(false); }
  }
  async function save() {
    if (busy || !draft || !dirty) return;
    const manifest = manifestFor(draft);
    if (!draft.name.trim()) { setError('请输入模板名称。'); nameInput.current?.focus(); return; }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.template)) { setError('模板标识需以小写字母开头，仅含小写字母、数字和连字符，最多 64 个字符。'); return; }
    for (const { key, label } of languages) {
      if (!manifest[key].length) { setError(`请至少填写一个 ${label} 版本。`); return; }
      if (!manifest[key].includes(manifest.defaults[key])) { setError(`请为 ${label} 选择安装列表中的默认版本。`); return; }
    }
    if (!Number.isInteger(manifest.cpuCount) || manifest.cpuCount < 1 || manifest.cpuCount > 8) { setError('CPU 核数需为 1 至 8 的整数。'); return; }
    if (!Number.isInteger(manifest.memoryMB) || manifest.memoryMB < 512 || manifest.memoryMB > 8192 || manifest.memoryMB % 256 !== 0) { setError('内存需为 512 至 8192 MiB，且为 256 的倍数。'); return; }
    setBusy(true); setError(''); setConflict(false); setMessage('');
    try {
      const saved = await request<TemplateDefinition>(creating ? '/api/templates' : `/api/templates/${encodeURIComponent(selected!.id)}`, creating ? 'POST' : 'PUT', { name: draft.name.trim(), manifest, ...(!creating ? { version: selected!.version } : {}) });
      if (!alive.current) return;
      ++inventoryEpoch.current;
      setInventory(current => current && { ...current, templates: [...current.templates.filter(item => item.id !== saved.id), saved] });
      applySelection(saved); setMessage('配置已保存。点击“构建并验证”生成可用模板。');
    } catch (err) { handleError(err); }
    finally { if (alive.current) setBusy(false); }
  }
  async function remove() {
    if (busy || !selected || deleteBlocked) return;
    setBusy(true); setError('');
    try {
      await request(`/api/templates/${encodeURIComponent(selected.id)}`, 'DELETE', { version: selected.version });
      if (!alive.current) return;
      ++inventoryEpoch.current;
      setInventory(current => current && { ...current, templates: current.templates.filter(item => item.id !== selected.id), builds: current.builds.filter(build => build.templateId !== selected.id) });
      applySelection(null); setMessage('已删除模板配置与本机构建记录。');
    } catch (err) { handleError(err); }
    finally { if (alive.current) { setBusy(false); setConfirmDelete(false); } }
  }
  async function build() {
    if (busy || dirty || !selected || inventory?.activeBuildId || !inventory?.enabled) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const created = await request<TemplateBuild>(`/api/templates/${encodeURIComponent(selected.id)}/builds`, 'POST', { version: selected.version });
      if (!alive.current) return;
      ++inventoryEpoch.current;
      setInventory(current => current && { ...current, activeBuildId: created.id, builds: [created, ...current.builds.filter(item => item.id !== created.id)] });
      setSelectedBuildId(created.id); setBuildDetails(created); setMessage('构建已开始，可以离开页面，稍后回来查看结果。');
    } catch (err) { handleError(err); }
    finally { if (alive.current) setBusy(false); }
  }
  async function activate() {
    if (busy || !currentBuild || currentBuild.status !== 'succeeded') return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await request<TemplateInventory>(`/api/template-builds/${encodeURIComponent(currentBuild.id)}/activate`, 'POST');
      if (!alive.current) return;
      ++inventoryEpoch.current; setInventory(next); setMessage('已设为默认模板。之后新建的项目沙箱使用此版本，已有沙箱保持原环境。'); onDefaultChanged?.();
    } catch (err) { handleError(err); }
    finally { if (alive.current) setBusy(false); }
  }

  return <main className="main-pane templates-page" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
  }}>
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>模板管理</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="templates-scroll">
      <div className="templates-heading"><div><span className="templates-eyebrow">SANDBOX ENVIRONMENTS</span><h1>沙箱模板</h1><p>配置语言与工具，构建一次，让新项目从准备好的环境开始。</p></div><button className="primary-button" disabled={busy || loading} onClick={() => startNew()}>＋ 新建模板</button></div>
      <div className="template-summary"><div className="template-summary-icon" aria-hidden="true">▧</div><div><span>新沙箱默认模板</span><strong title={inventory?.defaultTemplate}>{inventory?.defaultTemplate || '正在读取…'}</strong></div><p>构建成功后手动设为默认。<br />已有项目沙箱继续使用原环境。</p></div>
      {inventory && !inventory.enabled && <p className="template-notice">E2B 尚未配置，仍可管理模板配置；连接 E2B 后即可构建和验证。</p>}
      {activeBuild && <div className="template-active-notice" role="status"><span className="spinner" /><span>「{activeBuild.templateName}」{statusLabels[activeBuild.status]}，一次可执行一个构建。</span><button disabled={busy} onClick={() => { const item = inventory?.templates.find(item => item.id === activeBuild.templateId); if (!item || !allowDiscard()) return; applySelection(item); setSelectedBuildId(activeBuild.id); }}>查看进度 →</button></div>}
      {error && <div className="template-error" role="alert">{error}{conflict && <div><p>当前草稿仍保留。可重新加载最新配置后再操作。</p><button className="secondary-button" disabled={busy} onClick={() => void refresh()}>重新加载</button></div>}</div>}
      {message && <p className="template-message" role="status">{message}</p>}
      <div className="templates-workspace">
        <aside className="template-browser" aria-label="模板列表">
          <div className="template-browser-heading"><strong>全部模板 <span>{inventory?.templates.length ?? 0}</span></strong><button className="secondary-button" disabled={busy || loading} aria-label="刷新模板" onClick={() => void refresh()}>刷新</button></div>
          <input type="search" aria-label="搜索模板" placeholder="搜索名称或标识" value={query} onChange={event => setQuery(event.target.value)} />
          <nav className="template-list" aria-label="选择模板">
            {!visible.length && <p className="template-no-results">{loading ? '正在读取模板…' : inventory?.templates.length ? '没有匹配的模板。' : '还没有模板，创建一个开始。'}</p>}
            {visible.map(item => <button key={item.id} className={`template-row ${!creating && selected?.id === item.id ? 'selected' : ''}`} aria-current={!creating && selected?.id === item.id ? 'page' : undefined} disabled={busy} onClick={() => select(item)}><span className="template-row-top"><strong>{item.name}</strong>{isDefault(item.id) && <span className="template-default-badge">默认</span>}</span><code>{item.manifest.template}</code><span className="template-row-meta">{item.manifest.cpuCount} vCPU · {item.manifest.memoryMB} MiB<span>{item.manifest.go.length + item.manifest.node.length + item.manifest.python.length + (item.manifest.php ? 1 : 0)} 个语言版本</span></span></button>)}
          </nav>
          <div className="template-browser-help"><strong>从配置到可用环境</strong><ol><li>保存工具与版本清单</li><li>构建，并自动检查版本与编译</li><li>将通过验证的构建设为默认</li></ol><p>配置保存不会启动或更换沙箱。</p></div>
        </aside>
        <div className="template-detail">
          {draft ? <section className="template-editor" aria-label="模板配置">
            <div className="template-editor-heading"><div><span>{creating ? '新建模板' : '环境配置'}{dirty && <em>未保存</em>}</span><h2>{creating ? '配置新环境' : selected?.name}</h2></div><div className="template-actions">{!creating && <button className="secondary-button" disabled={busy} onClick={() => startNew(true)}>复制</button>}<button className="primary-button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '处理中…' : creating ? '创建配置' : '保存修改'}</button></div></div>
            <fieldset disabled={busy} className="template-fields">
              <div className="template-form-row"><label>模板名称<input ref={nameInput} maxLength={100} value={draft.name} placeholder="例如：全栈开发环境" onChange={event => changeDraft({ name: event.target.value })} /></label><label>模板标识<input value={draft.manifest.template} maxLength={64} spellCheck={false} placeholder="codex-dev" onChange={event => changeManifest({ template: event.target.value })} /><small>用于识别环境配置，每次构建会保留独立版本。</small></label></div>
              <div className="template-section-heading"><h3>语言版本</h3><span>同一沙箱内按项目选择版本</span></div>
              <div className="template-language-grid">{languages.map(({ key, label, manager }) => {
                const versions = splitList(draft[key]);
                return <div className="template-language" key={key}><div><strong>{label}</strong><span>{manager}</span></div><label>安装版本<textarea rows={2} value={draft[key]} placeholder="用逗号或换行分隔" spellCheck={false} onChange={event => changeDraft({ [key]: event.target.value })} /><small>填写完整版本号，逗号或换行分隔。</small></label><label>默认版本<select value={draft.manifest.defaults[key]} onChange={event => changeManifest({ defaults: { ...draft.manifest.defaults, [key]: event.target.value } })}>{!versions.includes(draft.manifest.defaults[key]) && <option value={draft.manifest.defaults[key]}>{draft.manifest.defaults[key] || '请选择'}（未在安装列表中）</option>}{versions.map(version => <option key={version} value={version}>{version}</option>)}</select></label></div>;
              })}</div>
              <div className="template-section-heading"><h3>PHP 运行环境</h3><span>可选 · 原生 CLI 与项目常用扩展，无需 Docker</span></div>
              <div className="template-form-row"><label>启用 PHP 8.0.30<button type="button" role="switch" aria-label="启用 PHP 8.0.30" aria-checked={Boolean(draft.manifest.php)} className={`toggle ${draft.manifest.php ? 'enabled' : ''}`} onClick={() => changeManifest({ php: draft.manifest.php ? undefined : structuredClone(defaultPhp) })}><span /></button><small>当前支持 PHP 8.0.30，启用后与其他语言安装在同一个沙箱。</small></label>{draft.manifest.php && <label>PHP 版本<input value={draft.manifest.php.version} readOnly /><small>同时安装 Composer，用于管理项目依赖。</small></label>}</div>
              {draft.manifest.php && <div className="template-manager-row"><label>Composer 版本<input value={draft.manifest.php.composer.version} readOnly /></label><label>Composer SHA-256<input value={draft.manifest.php.composer.sha256} readOnly spellCheck={false} /><small>构建时校验 Composer 安装包。</small></label></div>}
              <div className="template-section-heading"><h3>开发工具</h3><span>添加工具后重新构建即可</span></div>
              <div className="template-form-row"><label>系统软件包<textarea rows={4} value={draft.systemPackages} placeholder="git, curl, ripgrep" spellCheck={false} onChange={event => changeDraft({ systemPackages: event.target.value })} /><small>通过 apt 安装，包名用逗号或换行分隔。</small></label><label>其他 mise 工具<textarea rows={4} value={draft.extraMiseTools} placeholder={'例如：\nrust@1.85.0\njava@21.0.6'} spellCheck={false} onChange={event => changeDraft({ extraMiseTools: event.target.value })} /><small>每项使用 tool@version，固定版本便于复现。</small></label></div>
              <div className="template-section-heading"><h3>沙箱资源</h3><span>用于新模板的构建和运行</span></div>
              <div className="template-form-row"><label>CPU 核数<input type="number" min={1} max={8} step={1} value={draft.manifest.cpuCount} onChange={event => changeManifest({ cpuCount: Number(event.target.value) })} /></label><label>内存（MiB）<input type="number" min={512} max={8192} step={256} value={draft.manifest.memoryMB} onChange={event => changeManifest({ memoryMB: Number(event.target.value) })} /><small>本机 E2B 的资源额度会限制可用配置。</small></label></div>
              <details className="template-advanced"><summary>高级设置 <span>工具管理器与 Codex 运行环境</span></summary><p>更新 mise 或 uv 时，同时填写对应安装包的 SHA-256。</p><div className="template-form-row"><label>pnpm 版本<input value={draft.manifest.pnpm} onChange={event => changeManifest({ pnpm: event.target.value })} /></label><label>Codex App Server 版本<input value={draft.manifest.codexCli} readOnly /><small>跟随 Web 服务版本。</small></label></div>{(['mise', 'uv'] as const).map(manager => <div className="template-manager-row" key={manager}><label>{manager} 版本<input value={draft.manifest[manager].version} onChange={event => changeManifest({ [manager]: { ...draft.manifest[manager], version: event.target.value } })} /></label><label>{manager} SHA-256<input value={draft.manifest[manager].sha256} spellCheck={false} onChange={event => changeManifest({ [manager]: { ...draft.manifest[manager], sha256: event.target.value } })} /></label></div>)}</details>
            </fieldset>
            <div className="template-editor-footer"><p>{creating ? '先创建配置，再构建模板。' : dirty ? '保存修改后即可构建新版本。' : '配置已保存。构建和验证将在后台执行，日志会持续更新。'}</p><div>{!creating && <button className="template-delete-button" disabled={busy || deleteBlocked} title={deleteBlocked ? '正在构建或包含默认版本的模板不能删除' : '删除此模板的本地配置'} onClick={() => setConfirmDelete(true)}>删除配置</button>}<button className="primary-button" disabled={busy || dirty || creating || !!inventory?.activeBuildId || !inventory?.enabled} onClick={() => void build()}>构建并验证 <span aria-hidden="true">→</span></button></div></div>
            {confirmDelete && <div className="template-delete-confirm" role="group" aria-label="确认删除模板配置" onKeyDown={event => { if (event.key === 'Escape' && !busy) setConfirmDelete(false); }}><strong>删除「{selected?.name}」的配置？</strong><p>删除本地配置与构建历史，不会销毁远端模板、项目沙箱或其中的文件。{dirty && '未保存的修改也会丢弃。'}</p><div><button ref={cancelDelete} className="secondary-button" disabled={busy} onClick={() => setConfirmDelete(false)}>保留配置</button><button className="template-danger-button" disabled={busy || deleteBlocked} onClick={() => void remove()}>确认删除配置</button></div></div>}
          </section> : <section className="template-empty"><span aria-hidden="true">▧</span><h2>{loading ? '正在读取环境配置…' : '选择模板，管理开发环境'}</h2><p>安装所需语言、版本和工具，复用到每个新项目。</p><button className="primary-button" disabled={busy || loading} onClick={() => startNew()}>新建模板</button></section>}
          {selected && !creating && <section className="template-history" aria-label="构建历史"><div className="template-history-heading"><h2>构建历史 <span>{builds.length}</span></h2><span>每次构建保留独立环境</span></div>
            {!builds.length ? <div className="template-history-empty">还没有构建记录。保存配置后，点击“构建并验证”。</div> : <><div className="template-build-list" role="group" aria-label="选择构建">{builds.map(item => <button key={item.id} className={`template-build-row ${selectedBuildId === item.id ? 'selected' : ''}`} aria-pressed={selectedBuildId === item.id} onClick={() => setSelectedBuildId(item.id)}><span className={`template-build-status ${item.status}`}>{isRunning(item) && <span className="spinner" />}{statusLabels[item.status]}</span><span><time dateTime={item.startedAt}>{date(item.startedAt)}</time><code>{item.reference || item.id}</code></span>{item.reference && item.reference === inventory?.defaultTemplate && <span className="template-default-badge">当前默认</span>}</button>)}</div>
              {currentBuild && <div className="template-build-detail"><div className="template-build-heading"><div><h3>{statusLabels[currentBuild.status]}</h3><p>{currentBuild.finishedAt ? `完成于 ${date(currentBuild.finishedAt)}` : '任务在后台执行，离开页面不会停止构建。'}</p></div>{currentBuild.status === 'succeeded' && <button className="primary-button" disabled={busy || currentBuild.reference === inventory?.defaultTemplate} onClick={() => void activate()}>{currentBuild.reference === inventory?.defaultTemplate ? '当前默认版本' : '设为新沙箱默认'}</button>}</div>{currentBuild.reference && <div className="template-build-reference"><span>构建版本</span><code>{currentBuild.reference}</code></div>}{currentBuild.error && <p className="template-error" role="alert">{currentBuild.error}</p>}
                {currentBuild.verification && <details className="template-verification" open={!currentBuild.verification.passed}><summary>自动验证 {currentBuild.verification.passed ? '· 全部通过' : '· 未通过'} <span>{currentBuild.verification.checks.length} 项检查</span></summary><ul>{currentBuild.verification.checks.map((check, index) => <li key={`${check.name}-${index}`} className={check.failed || (check.exitCode !== undefined && check.exitCode !== 0) ? 'failed' : ''}><details><summary><span aria-hidden="true">{check.failed || (check.exitCode !== undefined && check.exitCode !== 0) ? '×' : '✓'}</span>{check.name}</summary>{check.output && <pre>{check.output}</pre>}</details></li>)}</ul></details>}
                <details className="template-manifest-snapshot"><summary>本次构建的配置快照</summary><pre>{JSON.stringify(currentBuild.manifest, null, 2)}</pre></details>
                <div className="template-log-heading"><strong>构建日志</strong><label><input type="checkbox" checked={followLogs} onChange={event => setFollowLogs(event.target.checked)} /> 跟随最新日志</label></div>{logError && <p className="template-error" role="alert">{logError} 正在自动重试…</p>}<pre ref={logPane} className="template-logs" aria-label="构建日志" tabIndex={0} onScroll={event => { const element = event.currentTarget; if (element.scrollHeight - element.scrollTop - element.clientHeight > 50) setFollowLogs(false); }}>{currentBuild.logs || (buildDetails ? '暂无日志。' : '正在读取日志…')}</pre>
              </div>}</>}
          </section>}
        </div>
      </div>
    </div>
  </main>;
}
