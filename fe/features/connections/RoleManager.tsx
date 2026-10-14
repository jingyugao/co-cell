import { useEffect, useState } from 'react';
import type { RoleCatalog, RoleConnection, SecretMetadata, ToolRole } from '../../../protocol/secret-types';
import { api, errorMessage } from '../../lib/api';
import { toolConnectionCommand } from '../../../util/tool-connection-command';

const STANDARD_TOOLS = ['mysql', 'kubectl', 'git', 'glab', 'meegle', 'lark-cli'];
const repeatable = (tool: string) => tool === 'mysql' || tool === 'kubectl';

export default function RoleManager({ secrets }: { secrets: SecretMetadata[] }) {
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState<ToolRole | 'new' | null>(null);
  const [name, setName] = useState(''), [connections, setConnections] = useState<RoleConnection[]>([]);
  async function refresh() { setCatalog(await api<RoleCatalog>('/api/tool-roles')); }
  useEffect(() => {
    const controller = new AbortController();
    void api<RoleCatalog>('/api/tool-roles', { signal: controller.signal }).then(setCatalog)
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const usableSecrets = secrets.filter(item => item.enabled && item.format === 'text' && !item.requiresTextImport && item.tool);
  const tools = [...new Set([...STANDARD_TOOLS, ...secrets.flatMap(item => item.tool ? [item.tool] : []), ...connections.map(item => item.tool)])];
  function start(role?: ToolRole) {
    setError(''); setName(role?.name ?? ''); setConnections(role ? role.connections.map(item => ({
      ...item,
      alias: secrets.find(secret => secret.id === item.secretId)?.name ?? item.alias,
    })) : []); setEditing(role ?? 'new');
  }
  function selectCredential(tool: string, secretId: string, selected: boolean) {
    setConnections(current => {
      if (!selected) return current.filter(item => item.tool !== tool || item.secretId !== secretId);
      if (current.some(item => item.tool === tool && item.secretId === secretId)) return current;
      const remaining = repeatable(tool) ? current : current.filter(item => item.tool !== tool);
      if (!secretId) return remaining;
      const secret = usableSecrets.find(item => item.id === secretId);
      if (!secret) return current;
      return [...remaining, { tool, secretId, alias: secret.name }];
    });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const body = JSON.stringify({ name: name.trim(), connections: connections.map(({ tool, secretId }) => ({ tool, secretId })) });
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
  return <section className="role-manager" aria-labelledby="tool-roles-title">
    <div className="connections-heading"><div><h2 id="tool-roles-title">工具角色</h2><p>将多个 MySQL 或 Kubernetes 连接组合成角色，再分配给项目。历史项目已统一迁移至初始的空权限默认角色；新项目使用当前默认角色。</p></div><button className="primary-button" disabled={busy || loading || !catalog} onClick={() => start()}>新建角色</button></div>
    {error && <p className="connections-error" role="alert">{error}</p>}
    {editing && <form className="secret-form role-form" onSubmit={event => void save(event)}>
      <h3>{editing === 'new' ? '新建角色' : `编辑 ${editing.name}`}</h3>
      <label>角色名称<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <div className="role-connections-heading"><strong>工具凭证</strong><span>未选择凭证的工具不可用；仅支持原生 login-path 或 context 的工具可选多个凭证。</span></div>
      <div className="role-tool-list">{tools.map(tool => {
        const selected = connections.filter(item => item.tool === tool);
        const available = usableSecrets.filter(item => item.tool === tool);
        const unavailable = selected.filter(item => !available.some(secret => secret.id === item.secretId));
        const secretName = (secretId: string) => secrets.find(item => item.id === secretId)?.name ?? '已删除的凭证';
        return <fieldset className="role-tool-group" key={tool} disabled={busy}>
          <legend>{tool}</legend>
          <p className="role-tool-hint">{repeatable(tool) ? `可选择多个凭证，使用原生 ${tool === 'mysql' ? 'login-path' : 'context'} 名称区分。` : '最多选择一个凭证。'}</p>
          {repeatable(tool) ? <div className="role-credential-options">
            {!available.length && !unavailable.length && <p>暂无可用凭证，请先添加或启用此工具的文本凭证。</p>}
            {available.map(secret => {
              const connection = selected.find(item => item.secretId === secret.id);
              return <div className={`role-credential-option${connection ? ' is-selected' : ''}`} key={secret.id}>
                <label className="role-credential-check"><input type="checkbox" aria-label={`${tool} 凭证：${secret.name}`} checked={!!connection} onChange={event => selectCredential(tool, secret.id, event.target.checked)} /><span>{secret.name}</span></label>
              </div>;
            })}
            {unavailable.map(connection => <label className="role-credential-check role-credential-unavailable" key={connection.secretId}><input type="checkbox" aria-label={`${tool} 凭证：${secretName(connection.secretId)}`} checked onChange={() => selectCredential(tool, connection.secretId, false)} /><span>{secretName(connection.secretId)} · 不可用，请取消选择或启用凭证</span></label>)}
          </div> : <label>认证凭证<select aria-label={`${tool} 凭证`} value={selected[0]?.secretId ?? ''} onChange={event => selectCredential(tool, event.target.value, true)}>
            <option value="">无权限</option>
            {available.map(secret => <option key={secret.id} value={secret.id}>{secret.name}</option>)}
            {unavailable.map(connection => <option key={connection.secretId} value={connection.secretId} disabled>{secretName(connection.secretId)}（不可用）</option>)}
          </select>{!available.length && <small>暂无可用凭证，请先添加或启用此工具的文本凭证。</small>}</label>}
        </fieldset>;
      })}</div>
      <div className="secret-actions"><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存角色'}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>取消</button></div>
    </form>}
    {loading ? <p role="status">正在读取工具角色…</p> : !catalog?.roles.length ? <div className="connections-empty">暂无工具角色。角色可包含多个 MySQL 或 Kubernetes 连接。</div> : <div className="secret-list">{catalog.roles.map(role => <article className="connection-card role-card" key={role.id}>
      <div className="connection-profile-title"><strong>{role.name}</strong><span>{catalog.defaultRoleId === role.id ? '默认角色' : ''}</span></div>
      {!role.connections.length ? <p>无工具连接</p> : <ul>{role.connections.map((connection, index) => {
        const credential = secrets.find(secret => secret.id === connection.secretId);
        const credentialName = credential?.name ?? connection.alias;
        const nativeNames = credential?.nativeNames ?? connection.nativeNames;
        return <li key={`${connection.tool}-${connection.secretId}-${index}`}><strong>{connection.tool}</strong> · {credentialName}{['mysql', 'kubectl'].includes(connection.tool) && nativeNames?.map(nativeName => <code key={nativeName}>{toolConnectionCommand(connection.tool, nativeName)}</code>)}</li>;
      })}</ul>}
      <div className="secret-actions"><button className="secondary-button" disabled={busy || catalog.defaultRoleId === role.id} onClick={() => void setDefault(role.id)}>{catalog.defaultRoleId === role.id ? '当前默认角色' : '设为默认'}</button><button className="secondary-button" aria-label={`编辑角色：${role.name}`} disabled={busy} onClick={() => start(role)}>编辑</button><button className="secondary-button" disabled={busy} onClick={() => void remove(role)}>删除</button></div>
    </article>)}</div>}
  </section>;
}
