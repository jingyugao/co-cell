import { useEffect, useRef, useState } from 'react';
import type { ProjectToolGrant, SecretMetadata } from '../../../protocol/secret-types';
import { api, errorMessage } from '../../lib/api';
import '../connections/SecretManager.css';

export default function ProjectToolGrants({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const base = `/api/projects/${projectId}/tool-grants`;
  const [secrets, setSecrets] = useState<SecretMetadata[]>([]);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [tools, setTools] = useState<string[]>([]);
  const [legacy, setLegacy] = useState<string[]>([]);
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoaded(false);
    void Promise.all([api<ProjectToolGrant[]>(base, { signal: controller.signal }), api<SecretMetadata[]>('/api/secrets', { signal: controller.signal })])
      .then(([grants, list]) => {
        if (controller.signal.aborted) return;
        const next = new Map<string, string>(), ambiguous: string[] = [];
        const names = [...new Set([...list.map(secret => secret.tool).filter((tool): tool is string => !!tool), ...grants.map(grant => grant.tool)])].sort();
        for (const tool of names) {
          const bindings = grants.filter(grant => grant.tool === tool && grant.enabled);
          if (bindings.length === 1 && bindings[0].files.length === 1) next.set(tool, bindings[0].files[0].secretId);
          else if (bindings.length) ambiguous.push(tool);
        }
        setTools(names); setSelected(next); setLegacy(ambiguous); setSecrets(list); setLoaded(true);
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
      await api(base, { method: 'PUT', body: JSON.stringify({ selections: tools.map(tool => ({ tool, secretId: selected.get(tool) || null })) }) });
      onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="tool-grants-dialog" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="tool-grants-panel tool-secret-picker" ref={panel} role="dialog" aria-modal="true" aria-label={`${name} 工具密钥`}
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="tool-secret-heading"><h2>{name} · 工具密钥</h2><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div>
      <p className="tool-secret-description">每种工具最多选择一个密钥。取消勾选即不授权，保存后下一次调用生效。</p>
      {error && <p className="connections-error" role="alert">{error}</p>}
      {!loading && loaded && !tools.length && <p className="tool-secret-note">暂无工具资源，可先在 Secret 管理中填写工具名并新建。</p>}
      {loading ? <p role="status">正在读取密钥…</p> : tools.map(tool => {
        const list = secrets.filter(secret => secret.tool === tool || secret.id === selected.get(tool));
        return <fieldset className="tool-secret-group" key={tool} disabled={busy || !loaded}>
          <legend>{tool}</legend>
          {legacy.includes(tool) && <p className="tool-secret-note">旧配置包含多个密钥，请重新选择一个。</p>}
          {list.length ? <div className="tool-secret-options">{list.map(secret => {
            const checked = selected.get(tool) === secret.id;
            const unavailable = !secret.enabled || secret.requiresTextImport;
            return <label key={secret.id} className={`tool-secret-option${checked ? ' is-selected' : ''}${unavailable ? ' is-disabled' : ''}`}>
              <input type="checkbox" checked={checked} disabled={unavailable && !checked}
                onChange={event => { const checked = event.target.checked; setSelected(value => { const next = new Map(value); if (checked) next.set(tool, secret.id); else next.delete(tool); return next; }); }} />
              <span>{secret.name}</span>{!secret.enabled ? <small>已停用</small> : secret.requiresTextImport && <small>需重新导入文本</small>}
            </label>;
          })}</div> : <p className="tool-secret-note">暂无密钥，可先在 Secret 管理中新建。</p>}
        </fieldset>;
      })}
      {!loading && secrets.some(secret => !secret.tool) && <p className="tool-secret-note">未分类的旧密钥，请先在 Secret 管理中填写工具名和路径。</p>}
      <div className="tool-secret-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={busy || !loaded || loading} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></div>
    </section>
  </div>;
}
