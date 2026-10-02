import { useEffect, useRef, useState } from 'react';
import { PROXY_TOOLS, type ProjectToolGrant, type ProxyTool, type SecretMetadata } from '../../../protocol/secret-types';
import { TOOL_LABELS } from '../../../util/tool-secrets';
import { api, errorMessage } from '../../lib/api';
import '../connections/SecretManager.css';

export default function ProjectToolGrants({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const base = `/api/projects/${projectId}/tool-grants`;
  const [secrets, setSecrets] = useState<SecretMetadata[]>([]);
  const [selected, setSelected] = useState<Partial<Record<ProxyTool, string>>>({});
  const [legacy, setLegacy] = useState<ProxyTool[]>([]);
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoaded(false);
    void Promise.all([api<ProjectToolGrant[]>(base, { signal: controller.signal }), api<SecretMetadata[]>('/api/secrets', { signal: controller.signal })])
      .then(([grants, list]) => {
        if (controller.signal.aborted) return;
        const next: Partial<Record<ProxyTool, string>> = {}, ambiguous: ProxyTool[] = [];
        for (const tool of PROXY_TOOLS) {
          const bindings = grants.filter(grant => grant.tool === tool && grant.enabled);
          if (bindings.length === 1 && bindings[0].files.length === 1) next[tool] = bindings[0].files[0].secretId;
          else if (bindings.length) ambiguous.push(tool);
        }
        setSelected(next); setLegacy(ambiguous); setSecrets(list); setLoaded(true);
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
      await api(base, { method: 'PUT', body: JSON.stringify({ selections: PROXY_TOOLS.map(tool => ({ tool, secretId: selected[tool] || null })) }) });
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
      {loading ? <p role="status">正在读取密钥…</p> : PROXY_TOOLS.map(tool => {
        const list = secrets.filter(secret => secret.tool === tool || secret.id === selected[tool]);
        return <fieldset className="tool-secret-group" key={tool} disabled={busy || !loaded}>
          <legend>{TOOL_LABELS[tool]}</legend>
          {legacy.includes(tool) && <p className="tool-secret-note">旧配置包含多个密钥，请重新选择一个。</p>}
          {list.length ? <div className="tool-secret-options">{list.map(secret => {
            const checked = selected[tool] === secret.id;
            return <label key={secret.id} className={`tool-secret-option${checked ? ' is-selected' : ''}${!secret.enabled ? ' is-disabled' : ''}`}>
              <input type="checkbox" checked={checked} disabled={!secret.enabled && !checked}
                onChange={event => setSelected(value => ({ ...value, [tool]: event.target.checked ? secret.id : '' }))} />
              <span>{secret.name}</span>{!secret.enabled && <small>已停用</small>}
            </label>;
          })}</div> : <p className="tool-secret-note">暂无密钥，可先在 Secret 管理中新建。</p>}
        </fieldset>;
      })}
      {!loading && secrets.some(secret => !secret.tool) && <p className="tool-secret-note">未分类的旧密钥，请先在 Secret 管理中选择所属工具。</p>}
      <div className="tool-secret-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={busy || !loaded || loading} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></div>
    </section>
  </div>;
}
