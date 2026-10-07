import { useEffect, useRef, useState } from 'react';
import type { ProjectToolPermission } from '../../../protocol/secret-types';
import { api, errorMessage } from '../../lib/api';
import '../connections/SecretManager.css';

export default function ProjectToolGrants({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const base = `/api/projects/${projectId}/tool-permissions`;
  const [permissions, setPermissions] = useState<ProjectToolPermission[]>([]);
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoaded(false);
    void api<ProjectToolPermission[]>(base, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setPermissions(value); setLoaded(true); }
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base]);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  async function save() {
    setBusy(true); setError('');
    try {
      await api(base, { method: 'PUT', body: JSON.stringify({ permissions: permissions.map(({ tool, enabled }) => ({ tool, enabled })) }) });
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
      <p className="tool-secret-description">每种工具只设置有或无权限。凭证在 Secret 管理中统一配置。</p>
      {error && <p className="connections-error" role="alert">{error}</p>}
      {!loading && loaded && !permissions.length && <p className="tool-secret-note">暂无工具，请先在 Secret 管理中配置凭证。</p>}
      {loading ? <p role="status">正在读取工具权限…</p> : permissions.map(permission => <fieldset className="tool-secret-group" key={permission.tool} disabled={busy || !loaded}>
        <legend>{permission.tool}</legend>
        <div className="tool-permission-options">{[true, false].map(enabled => <label key={String(enabled)} className={`tool-secret-option${permission.enabled === enabled ? ' is-selected' : ''}${enabled && !permission.available ? ' is-disabled' : ''}`}>
          <input type="radio" name={`tool-permission-${permission.tool}`} checked={permission.enabled === enabled} disabled={enabled && !permission.available}
            onChange={() => setPermissions(current => current.map(value => value.tool === permission.tool ? { ...value, enabled } : value))} />
          <span>{enabled ? '有' : '无'}</span>
        </label>)}</div>
        {permission.reason && <p className="tool-secret-note">{permission.reason}</p>}
      </fieldset>)}
      <div className="tool-secret-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={busy || !loaded || loading} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></div>
    </section>
  </div>;
}
