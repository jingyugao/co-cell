import { useEffect, useRef, useState } from 'react';
import type { RoleCatalog, ToolCatalogEntry, ToolPermission, ToolRole } from '../../../protocol/secret-types';
import { api, errorMessage } from '../../lib/api';
import EditorDialog from './EditorDialog';
import { useDraftStatus } from './DraftGuard';

const emptyPermission = (entry: ToolCatalogEntry): ToolPermission => entry.kind === 'tool-with-credential'
  ? { tool: entry.name, enabled: false, credentials: [] }
  : { tool: entry.name, enabled: false };

function permissionSummary(permission: ToolPermission) {
  if (!permission.enabled) return null;
  return <li key={permission.tool}><strong>{permission.tool}</strong>{permission.credentials?.map(name => <code key={name}>{name}</code>)}</li>;
}

export default function RoleManager() {
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null);
  const [tools, setTools] = useState<ToolCatalogEntry[] | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState<ToolRole | 'new' | null>(null);
  const [name, setName] = useState(''), [permissions, setPermissions] = useState<ToolPermission[]>([]);
  const editorBaseline = useRef('');
  const editorDirty = editing !== null && JSON.stringify({ name, permissions }) !== editorBaseline.current;
  const draftGuard = useDraftStatus('role-editor', editorDirty, busy && editing !== null);

  async function refresh() {
    const [roleCatalog, toolCatalog] = await Promise.all([
      api<RoleCatalog>('/api/tool-roles'), api<ToolCatalogEntry[]>('/api/tools'),
    ]);
    setCatalog(roleCatalog); setTools(toolCatalog);
  }
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<RoleCatalog>('/api/tool-roles', { signal: controller.signal }),
      api<ToolCatalogEntry[]>('/api/tools', { signal: controller.signal }),
    ]).then(([roleCatalog, toolCatalog]) => {
      if (controller.signal.aborted) return;
      setCatalog(roleCatalog); setTools(toolCatalog);
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const reload = () => { void refresh().catch(err => setError(errorMessage(err))); };
    window.addEventListener('cocell:tool-catalog-changed', reload);
    return () => window.removeEventListener('cocell:tool-catalog-changed', reload);
  }, []);

  function start(role?: ToolRole) {
    setError(''); setName(role?.name ?? '');
    const current = role?.permissions ?? [];
    const nextPermissions = [...(tools ?? []).map(entry => current.find(permission => permission.tool === entry.name) ?? emptyPermission(entry)),
      ...current.filter(permission => !(tools ?? []).some(entry => entry.name === permission.tool))]
      .map(permission => ({ ...permission, ...(permission.credentials ? { credentials: [...permission.credentials] } : {}) }));
    editorBaseline.current = JSON.stringify({ name: role?.name ?? '', permissions: nextPermissions });
    setPermissions(nextPermissions);
    setEditing(role ?? 'new');
  }

  function closeEditor() {
    if (!busy && (!draftGuard || draftGuard.canLeave(['role-editor']))) setEditing(null);
  }

  function setSimplePermission(tool: string, enabled: boolean) {
    setPermissions(current => {
      const next = current.filter(permission => permission.tool !== tool);
      return [...next, { tool, enabled }];
    });
  }

  function selectCredential(tool: string, credential: string, selected: boolean) {
    setPermissions(current => {
      const previous = current.find(permission => permission.tool === tool);
      const credentials = new Set(previous?.credentials ?? []);
      if (selected) credentials.add(credential); else credentials.delete(credential);
      const values = [...credentials];
      return [...current.filter(permission => permission.tool !== tool), {
        tool, enabled: values.length > 0, credentials: values,
      }];
    });
  }

  function normalizePermissions(current: ToolPermission[]) {
    return [...(tools ?? []).map(entry => {
      const permission = current.find(item => item.tool === entry.name) ?? emptyPermission(entry);
      if (entry.kind === 'tool-with-credential') {
        const credentials = permission.enabled ? [...new Set(permission.credentials ?? [])] : [];
        return { tool: entry.name, enabled: credentials.length > 0, credentials };
      }
      return { tool: entry.name, enabled: permission.enabled };
    }), ...current.filter(permission => permission.enabled && !(tools ?? []).some(entry => entry.name === permission.tool)).map(permission => ({
      tool: permission.tool, enabled: permission.enabled,
      ...(permission.enabled && permission.credentials?.length ? { credentials: [...new Set(permission.credentials)] } : {}),
    }))];
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!catalog || !tools) { setError('工具角色或工具目录尚未加载，不能保存。'); return; }
    const normalized = normalizePermissions(permissions);
    if (normalized.some(permission => permission.enabled && tools.find(entry => entry.name === permission.tool)?.kind === 'tool-with-credential'
      && !permission.credentials?.length)) {
      setError('启用凭据工具时，至少选择一个连接名称。'); return;
    }
    setBusy(true); setError('');
    try {
      const body = JSON.stringify({ name: name.trim(), permissions: normalized });
      const path = editing === 'new' ? '/api/tool-roles' : `/api/tool-roles/${editing?.id}`;
      await api(path, { method: editing === 'new' ? 'POST' : 'PUT', body });
      setEditing(null); await refresh();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  async function setDefault(roleId: string) {
    setBusy(true); setError('');
    try { setCatalog(await api<RoleCatalog>('/api/tool-roles/default', { method: 'PUT', body: JSON.stringify({ roleId }) })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function remove(role: ToolRole) {
    setBusy(true); setError('');
    try { await api(`/api/tool-roles/${role.id}`, { method: 'DELETE' }); await refresh(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  const ready = !!catalog && !!tools && !loading;
  return <section className="role-manager" aria-labelledby="tool-roles-title">
    <div className="connections-heading"><div><h2 id="tool-roles-title">工具角色</h2><p>所有 debug 进程共用 HOME 和连接配置。角色控制可调用哪些工具和连接名称；调用时会按角色所选名称校验权限。新项目使用当前默认角色。</p></div><button className="primary-button" disabled={busy || !ready} onClick={() => start()}>新建角色</button></div>
    {error && !editing && <p className="connections-error" role="alert">{error}</p>}
    {editing && <EditorDialog title={editing === 'new' ? '新建角色' : `编辑角色：${editing.name}`} busy={busy} error={error} onClose={closeEditor}>
      <form className="secret-form role-form" onSubmit={event => void save(event)}>
      <label>角色名称<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <div className="role-connections-heading"><strong>工具权限</strong><span>勾选工具或共享 HOME 中的连接名称。未选中的连接不会授权给项目。</span></div>
      {!ready ? <p role="status">正在读取工具目录…</p> : <div className="role-tool-list">{tools!.map(entry => {
        const permission = permissions.find(item => item.tool === entry.name) ?? emptyPermission(entry);
        if (entry.kind === 'tool') return <fieldset className="role-tool-group" key={entry.name} disabled={busy}>
          <legend>{entry.name}</legend>
          <label className="role-credential-check"><input type="checkbox" aria-label={`${entry.name} 工具权限`} checked={permission.enabled}
            onChange={event => setSimplePermission(entry.name, event.target.checked)} /><span>允许调用此工具</span></label>
        </fieldset>;
        const selected = new Set(permission.credentials ?? []);
        const unavailable = [...selected].filter(credential => !entry.credentials.includes(credential));
        return <fieldset className="role-tool-group" key={entry.name} disabled={busy}>
          <legend>{entry.name}</legend>
          <p className="role-tool-hint">仅允许使用所选名称。连接配置仍由共享 HOME 管理。</p>
          <div className="role-credential-options">
            {!entry.credentials.length && !unavailable.length && <p>当前没有可用连接名称。</p>}
            {entry.credentials.map(credential => <div className={`role-credential-option${selected.has(credential) ? ' is-selected' : ''}`} key={credential}>
              <label className="role-credential-check"><input type="checkbox" aria-label={`${entry.name} 连接：${credential}`}
                checked={selected.has(credential)} onChange={event => selectCredential(entry.name, credential, event.target.checked)} /><span>{credential}</span>
                {entry.defaultCredential === credential && <small>默认</small>}</label>
            </div>)}
            {unavailable.map(credential => <div className="role-credential-check role-credential-unavailable" key={credential}>
              <span>{credential} · 连接已不存在</span><button type="button" className="secondary-button" aria-label={`移除 ${entry.name} 连接：${credential}`}
                disabled={busy} onClick={() => selectCredential(entry.name, credential, false)}>移除</button>
            </div>)}
          </div>
          {!selected.size && <small>未选择连接名称时，此工具保持禁用。</small>}
        </fieldset>;
      })}
      {permissions.filter(permission => !(tools ?? []).some(entry => entry.name === permission.tool)).map(permission => <fieldset className="role-tool-group" key={permission.tool} disabled={busy}>
        <legend>{permission.tool} · 工具目录中不存在</legend>
        <p className="role-tool-hint">此权限已不在工具目录中。取消选择后可从角色中移除。</p>
        <label className="role-credential-check role-credential-unavailable"><input type="checkbox" checked={permission.enabled}
          onChange={event => setSimplePermission(permission.tool, event.target.checked)} /><span>保留原有权限</span></label>
      </fieldset>)}</div>}
      <div className="secret-actions"><button className="primary-button" disabled={busy || !ready || !name.trim()}>{busy ? '保存中…' : '保存角色'}</button><button type="button" className="secondary-button" disabled={busy} onClick={closeEditor}>取消</button></div>
      </form>
    </EditorDialog>}
    {loading ? <p role="status">正在读取工具角色…</p> : !catalog?.roles.length ? <div className="connections-empty">暂无工具角色。</div> : <div className="secret-list">{catalog.roles.map(role => <article className="connection-card role-card" key={role.id}>
      <div className="connection-profile-title"><strong>{role.name}</strong><span>{catalog.defaultRoleId === role.id ? '默认角色' : ''}</span></div>
      {role.permissions.some(permission => permission.enabled) ? <ul>{role.permissions.map(permissionSummary)}</ul> : <p>无工具权限</p>}
      <div className="secret-actions"><button className="secondary-button" disabled={busy || catalog.defaultRoleId === role.id} onClick={() => void setDefault(role.id)}>{catalog.defaultRoleId === role.id ? '当前默认角色' : '设为默认'}</button><button className="secondary-button" aria-label={`编辑角色：${role.name}`} disabled={busy || !ready} onClick={() => start(role)}>编辑</button><button className="secondary-button" disabled={busy} onClick={() => void remove(role)}>删除</button></div>
    </article>)}</div>}
  </section>;
}
