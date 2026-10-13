import { useEffect, useState } from 'react';
import type { RoleCatalog, RoleConnection, SecretMetadata, ToolRole } from '../../../protocol/secret-types';
import { api, errorMessage } from '../../lib/api';

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
type DraftConnection = RoleConnection;

export default function RoleManager({ secrets }: { secrets: SecretMetadata[] }) {
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState<ToolRole | 'new' | null>(null);
  const [name, setName] = useState(''), [connections, setConnections] = useState<DraftConnection[]>([]);
  async function refresh() { setCatalog(await api<RoleCatalog>('/api/tool-roles')); }
  useEffect(() => {
    const controller = new AbortController();
    void api<RoleCatalog>('/api/tool-roles', { signal: controller.signal }).then(setCatalog)
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const usableSecrets = secrets.filter(item => item.enabled && item.format === 'text' && !item.requiresTextImport && item.tool);
  const tools = [...new Set(usableSecrets.map(item => item.tool as string))].sort();
  const repeatable = (tool: string) => tool === 'mysql' || tool === 'kubectl';
  const toolsFor = (index: number) => tools.filter(tool => repeatable(tool) || !connections.some((item, i) => i !== index && item.tool === tool));
  function start(role?: ToolRole) {
    setError(''); setName(role?.name ?? ''); setConnections(role ? role.connections.map(item => ({ ...item })) : tools.length ? [{ tool: tools[0], alias: '', secretId: '' }] : []); setEditing(role ?? 'new');
  }
  function patch(index: number, value: Partial<DraftConnection>) {
    setConnections(current => current.map((item, i) => i === index ? { ...item, ...value } : item));
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (connections.some(item => !ALIAS_PATTERN.test(item.alias))) throw new Error('连接别名须以字母开头，且只能包含字母、数字、点、下划线或连字符（最多 64 个字符）。');
      if (connections.some((item, index) => connections.some((other, otherIndex) => otherIndex !== index && item.tool === other.tool && item.alias === other.alias))) throw new Error('同一工具下的连接别名不能重复。');
      const body = JSON.stringify({ name: name.trim(), connections });
      const path = editing === 'new' ? '/api/tool-roles' : `/api/tool-roles/${editing?.id}`;
      await api(path, { method: editing === 'new' ? 'POST' : 'PUT', body });
      setEditing(null); await refresh();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function setDefault(roleId: string | null) {
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
    <div className="connections-heading"><div><h2 id="tool-roles-title">工具角色</h2><p>将多个 MySQL 或 Kubernetes 连接组合成角色，再分配给项目。默认角色仅自动分配给新创建的项目，不会更改现有项目。</p></div><button className="primary-button" disabled={busy || loading || !catalog} onClick={() => start()}>新建角色</button></div>
    {error && <p className="connections-error" role="alert">{error}</p>}
    {editing && <form className="secret-form role-form" onSubmit={event => void save(event)}>
      <h3>{editing === 'new' ? '新建角色' : `编辑 ${editing.name}`}</h3>
      <label>角色名称<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <div className="role-connections-heading"><strong>连接</strong><button type="button" className="secondary-button" disabled={busy || !toolsFor(connections.length).length} onClick={() => setConnections(current => [...current, { tool: toolsFor(current.length)[0] ?? '', alias: '', secretId: '' }])}>添加连接</button></div>
      {!tools.length && <p>没有可用的文本 Secret。请先启用 MySQL 或 kubectl Secret。</p>}
      {connections.map((connection, index) => <fieldset className="role-connection-row" key={index} disabled={busy}>
        <label>工具<select aria-label={`连接 ${index + 1} 工具`} value={connection.tool} onChange={event => patch(index, { tool: event.target.value, alias: '', secretId: '' })}>{toolsFor(index).map(tool => <option key={tool}>{tool}</option>)}</select></label>
        <label>别名<input aria-label={`连接 ${index + 1} 别名`} required maxLength={64} pattern={ALIAS_PATTERN.source} value={connection.alias} placeholder="例如 reporting" onChange={event => patch(index, { alias: event.target.value })} /><small>{['mysql', 'kubectl'].includes(connection.tool) ? `${connection.tool} --connection=别名` : '此工具按自身支持的方式使用连接别名'}</small></label>
        <label>认证 Secret<select aria-label={`连接 ${index + 1} 认证 Secret`} required value={connection.secretId} onChange={event => patch(index, { secretId: event.target.value })}><option value="">请选择</option>{usableSecrets.filter(item => item.tool === connection.tool).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className="secondary-button role-remove-connection" aria-label={`删除连接 ${index + 1}`} onClick={() => setConnections(current => current.filter((_, i) => i !== index))}>删除</button>
      </fieldset>)}
      <div className="secret-actions"><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存角色'}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>取消</button></div>
    </form>}
    {loading ? <p role="status">正在读取工具角色…</p> : !catalog?.roles.length ? <div className="connections-empty">暂无工具角色。角色可包含多个 MySQL 或 Kubernetes 连接。</div> : <div className="secret-list">{catalog.roles.map(role => <article className="connection-card role-card" key={role.id}>
      <div className="connection-profile-title"><strong>{role.name}</strong><span>{catalog.defaultRoleId === role.id ? '默认角色' : ''}</span></div>
      {!role.connections.length ? <p>无工具连接</p> : <ul>{role.connections.map((connection, index) => <li key={`${connection.tool}-${connection.alias}-${index}`}><strong>{connection.tool}</strong> · {connection.alias}{['mysql', 'kubectl'].includes(connection.tool) && <code>{connection.tool} --connection={connection.alias}</code>}</li>)}</ul>}
      <div className="secret-actions"><button className="secondary-button" disabled={busy} onClick={() => void setDefault(catalog.defaultRoleId === role.id ? null : role.id)}>{catalog.defaultRoleId === role.id ? '取消默认' : '设为默认'}</button><button className="secondary-button" aria-label={`编辑角色：${role.name}`} disabled={busy} onClick={() => start(role)}>编辑</button><button className="secondary-button" disabled={busy} onClick={() => void remove(role)}>删除</button></div>
    </article>)}</div>}
    {catalog?.defaultRoleId && <button className="secondary-button role-clear-default" disabled={busy} onClick={() => void setDefault(null)}>清除新项目默认角色</button>}
  </section>;
}
