import { useEffect, useState } from 'react';
import type { ProjectToolGrant, ProxyTool, SecretMetadata } from '../../../protocol/secret-types';
import { api, errorMessage } from '../../lib/api';
import '../connections/SecretManager.css';

const defaultPaths: Record<ProxyTool, string> = { mysql: '.my.cnf', kubectl: '.kube/config', glab: '.config/glab-cli/config.yml', 'lark-cli': '.lark-cli/config.json', meegle: '.meegle/credentials.json' };
export default function ProjectToolGrants({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const base = `/api/projects/${projectId}/tool-grants`;
  const [grants, setGrants] = useState<ProjectToolGrant[]>([]), [secrets, setSecrets] = useState<SecretMetadata[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [tool, setTool] = useState<ProxyTool>('mysql'), [alias, setAlias] = useState('');
  const [files, setFiles] = useState([{ secretId: '', path: defaultPaths.mysql }]);
  const [namespaces, setNamespaces] = useState(''), [resources, setResources] = useState('pods,pods/log');
  const [prefixes, setPrefixes] = useState('[ ["mr", "list"], ["mr", "view"] ]');
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api<ProjectToolGrant[]>(base, { signal: controller.signal }), api<SecretMetadata[]>('/api/secrets', { signal: controller.signal })]).then(([next, list]) => { setGrants(next); setSecrets(list); }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base]);
  function edit(grant: ProjectToolGrant) { setTool(grant.tool); setAlias(grant.alias); setFiles(grant.files); setNamespaces(grant.policy.namespaces.join(',')); setResources(grant.policy.resources.join(',')); setPrefixes(JSON.stringify(grant.policy.commandPrefixes, null, 2)); }
  const split = (value: string) => value.split(',').map(s => s.trim()).filter(Boolean);
  return <div className="tool-grants-dialog" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><section className="tool-grants-panel" role="dialog" aria-modal="true" aria-label={`${name} 工具权限`}>
    <div className="secret-actions"><h2>{name} · 工具权限</h2><button className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div>
    <p>未绑定的连接不可使用。保存或撤销授权后，下一次工具调用生效；已运行的调用继续执行。</p>
    {error && <p className="connections-error" role="alert">{error}</p>}
    {loading ? <p role="status">正在读取授权…</p> : grants.length ? grants.map(grant => <article className="tool-grant-row" key={grant.id}><div className="secret-actions"><strong>{grant.tool} · {grant.alias}</strong><span>{grant.enabled ? '启用' : '停用'}</span><button className="secondary-button" disabled={busy} onClick={() => edit(grant)}>编辑</button><button className="secondary-button" disabled={busy} onClick={async () => {
      setBusy(true); setError(''); try { await api(`${base}/${grant.id}`, { method: 'DELETE' }); setGrants(await api(base)); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
    }}>撤销</button></div><p>{grant.files.map(file => `${secrets.find(secret => secret.id === file.secretId)?.name ?? file.secretId} → ${file.path}`).join('；')}</p>{grant.tool === 'kubectl' && <p>namespace：{grant.policy.namespaces.join(', ')} · 资源：{grant.policy.resources.join(', ')}</p>}{!['mysql', 'kubectl'].includes(grant.tool) && <code>{JSON.stringify(grant.policy.commandPrefixes)}</code>}</article>) : <p>此项目尚未授权任何工具连接。</p>}
    <form className="secret-form" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        const commandPrefixes = ['mysql', 'kubectl'].includes(tool) ? [] : JSON.parse(prefixes);
        await api(base, { method: 'POST', body: JSON.stringify({ tool, alias, enabled: true, files, policy: { namespaces: tool === 'kubectl' ? split(namespaces) : [], resources: tool === 'kubectl' ? split(resources) : [], commandPrefixes } }) });
        setGrants(await api(base)); setAlias('');
      } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
    }}>
      <h2>配置连接</h2>
      <label>工具<select value={tool} onChange={e => { const value = e.target.value as ProxyTool; setTool(value); setFiles([{ secretId: '', path: defaultPaths[value] }]); }}><option>mysql</option><option>kubectl</option><option>glab</option><option>lark-cli</option><option>meegle</option></select></label>
      <label>连接别名<input required maxLength={64} pattern="[A-Za-z][A-Za-z0-9_.-]*" value={alias} onChange={e => setAlias(e.target.value)} /></label>
      <label>认证文件</label>{files.map((file, index) => <div className="tool-grant-files" key={index}><select required aria-label={`Secret ${index + 1}`} value={file.secretId} onChange={e => setFiles(files.map((item, i) => i === index ? { ...item, secretId: e.target.value } : item))}><option value="">选择 Secret</option>{secrets.filter(secret => secret.enabled).map(secret => <option key={secret.id} value={secret.id}>{secret.name} ({secret.format})</option>)}</select><input required aria-label={`认证文件路径 ${index + 1}`} value={file.path} onChange={e => setFiles(files.map((item, i) => i === index ? { ...item, path: e.target.value } : item))} /><button type="button" className="secondary-button" disabled={files.length === 1} onClick={() => setFiles(files.filter((_, i) => i !== index))}>移除</button></div>)}
      {!['mysql', 'kubectl'].includes(tool) && <button type="button" className="secondary-button" disabled={files.length >= 10} onClick={() => setFiles([...files, { secretId: '', path: '' }])}>添加认证文件</button>}
      {tool === 'mysql' && <p>JSON 连接配置使用 .my.cnf，支持 host、user、password、port、database。上传原生登录文件时使用 .mylogin.cnf，连接别名需与 login-path 一致。仅允许单条只读 SQL；实际库表权限由数据库账号限制。</p>}
      {tool === 'kubectl' && <><label>允许的 namespace（逗号分隔，* 表示全部）<input required value={namespaces} onChange={e => setNamespaces(e.target.value)} /></label><label>允许的资源（精确名称，日志使用 pods/log）<input required value={resources} onChange={e => setResources(e.target.value)} /></label><p>认证文件使用包含一个 context 的 kubeconfig JSON。禁止认证插件和外部文件引用。</p></>}
      {!['mysql', 'kubectl'].includes(tool) && <label>允许的命令前缀（JSON 数组）<textarea required rows={4} value={prefixes} onChange={e => setPrefixes(e.target.value)} /><span>例如 [["mr","list"],["mr","view"]]。目标服务 token 必须限制实际资源权限。</span></label>}
      <button className="primary-button" disabled={busy || loading}>{busy ? '保存中…' : '保存授权'}</button>
    </form>
  </section></div>;
}
