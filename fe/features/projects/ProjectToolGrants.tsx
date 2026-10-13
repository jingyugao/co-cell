import { useEffect, useRef, useState } from 'react';
import type { ProjectRoleState, ProjectToolPermission, RoleCatalog } from '../../../protocol/secret-types';
import { api, errorMessage } from '../../lib/api';
import '../connections/SecretManager.css';

type Selection = 'legacy' | 'none' | string;
export default function ProjectToolGrants({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const roleBase = `/api/projects/${projectId}/tool-role`;
  const permissionBase = `/api/projects/${projectId}/tool-permissions`;
  const [state, setState] = useState<ProjectRoleState | null>(null), [catalog, setCatalog] = useState<RoleCatalog | null>(null);
  const [permissions, setPermissions] = useState<ProjectToolPermission[]>([]);
  const [selection, setSelection] = useState<Selection>('none');
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoaded(false); setError('');
    void Promise.all([
      api<ProjectRoleState>(roleBase, { signal: controller.signal }),
      api<RoleCatalog>('/api/tool-roles', { signal: controller.signal }),
    ]).then(async ([roleState, roleCatalog]) => {
      if (controller.signal.aborted) return;
      setState(roleState); setCatalog(roleCatalog);
      setSelection(roleState.legacy ? 'legacy' : roleState.roleId ?? 'none');
      if (roleState.legacy) setPermissions(await api<ProjectToolPermission[]>(permissionBase, { signal: controller.signal }));
      if (!controller.signal.aborted) setLoaded(true);
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [permissionBase, roleBase]);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  const role = catalog?.roles.find(item => item.id === selection);
  async function save() {
    if (!state || !loaded) return;
    setBusy(true); setError('');
    try {
      if (selection === 'legacy' && state.legacy) {
        await api(permissionBase, { method: 'PUT', body: JSON.stringify({ permissions: permissions.map(({ tool, enabled }) => ({ tool, enabled })) }) });
      } else {
        await api<ProjectRoleState>(roleBase, { method: 'PUT', body: JSON.stringify({ roleId: selection === 'none' || selection === 'legacy' ? null : selection }) });
      }
      onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="tool-grants-dialog" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="tool-grants-panel tool-secret-picker" ref={panel} role="dialog" aria-modal="true" aria-label={`${name} 工具权限`}
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="tool-secret-heading"><h2>{name} · 工具权限</h2><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div>
      <p className="tool-secret-description">选择项目可使用的工具角色。无权限会移除项目中所有工具凭证访问。</p>
      {error && <p className="connections-error" role="alert">{error}</p>}
      {loading ? <p role="status">正在读取项目工具权限…</p> : loaded && <>
        <fieldset className="project-role-options" disabled={busy}>
          <legend>项目角色</legend>
          {catalog?.roles.map(item => <label className={`tool-secret-option${selection === item.id ? ' is-selected' : ''}`} key={item.id}>
            <input type="radio" name="project-role" checked={selection === item.id} onChange={() => setSelection(item.id)} />
            <span>{item.name}</span>{item.id === catalog.defaultRoleId && <small>仅新项目默认</small>}
          </label>)}
          <label className={`tool-secret-option${selection === 'none' ? ' is-selected' : ''}`}><input type="radio" name="project-role" checked={selection === 'none'} onChange={() => setSelection('none')} /><span>无权限</span></label>
          {state?.legacy && <label className={`tool-secret-option${selection === 'legacy' ? ' is-selected' : ''}`}><input type="radio" name="project-role" checked={selection === 'legacy'} onChange={() => setSelection('legacy')} /><span>保留现有权限</span><small>旧配置</small></label>}
        </fieldset>
        {selection === 'legacy' && state?.legacy ? <>
          <p className="tool-secret-note">当前项目使用旧版逐工具权限。选择角色或无权限后，将切换到角色权限。</p>
          {!permissions.length && <p className="tool-secret-note">暂无工具，请先在 Secret 管理中配置凭证。</p>}
          {permissions.map(permission => <fieldset className="tool-secret-group" key={permission.tool} disabled={busy}>
            <legend>{permission.tool}</legend>
            <div className="tool-permission-options">{[true, false].map(enabled => <label key={String(enabled)} className={`tool-secret-option${permission.enabled === enabled ? ' is-selected' : ''}${enabled && !permission.available ? ' is-disabled' : ''}`}>
              <input type="radio" name={`tool-permission-${permission.tool}`} checked={permission.enabled === enabled} disabled={enabled && !permission.available}
                onChange={() => setPermissions(current => current.map(value => value.tool === permission.tool ? { ...value, enabled } : value))} />
              <span>{enabled ? '有' : '无'}</span>
            </label>)}</div>
            {permission.reason && <p className="tool-secret-note">{permission.reason}</p>}
          </fieldset>)}
        </> : !role && selection !== 'none' ? <p className="tool-secret-note" role="status">当前项目关联的角色已不存在。请明确选择一个角色或“无权限”后保存。</p> : role && <section className="project-role-preview" aria-label={`${role.name} 连接预览`}>
          <h3>{role.name} · 连接预览</h3>
          {!role.connections.length ? <p className="tool-secret-note">此角色没有连接。</p> : <ul>{role.connections.map((connection, index) => <li key={`${connection.tool}-${connection.alias}-${index}`}><strong>{connection.tool}</strong> · {connection.alias}{['mysql', 'kubectl'].includes(connection.tool) && <code>{connection.tool} --connection={connection.alias}</code>}</li>)}</ul>}
        </section>}
      </>}
      <div className="tool-secret-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={busy || !loaded || loading} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></div>
    </section>
  </div>;
}
