import { useEffect, useRef, useState } from 'react';
import type { ConnectionInventory } from '../../../protocol/connection-types';
import './ConnectionsPage.css';

type Props = { onMenu: () => void; onBack: () => void };
const kinds = [
  { type: 'kubernetes', label: 'Kubernetes', tool: 'kubectl', symbol: '⎈', description: '开发调试身份：查看资源、日志和 ConfigMap/Secret，进入已有 Pod 及端口转发；禁止通过 Kubernetes API 创建、删除或修改资源。' },
  { type: 'glab', label: 'GitLab', tool: 'glab', symbol: '⌘', description: '沿用本机 GitLab 登录，查询仓库、合并请求和流水线。' },
  { type: 'mysql', label: '数据库', tool: 'mysql', symbol: '▤', description: '同步本机数据库连接配置，在沙箱内使用 MySQL 客户端。' },
  { type: 'git', label: 'Git', tool: 'git', symbol: '⑂', description: '同步本机 Git 身份与已导入的仓库认证配置。' },
  { type: 'lark', label: '飞书', tool: 'lark-cli', symbol: '↗', description: '同步本机飞书应用与可用的登录身份，访问已授权的飞书能力。' },
  { type: 'meegle', label: '飞书项目', tool: 'meegle', symbol: '▱', description: '同步本机 Meegle 连接配置，访问已授权的需求、工作项和项目流程。' },
] as const;
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
async function request(path: string, method = 'GET', signal?: AbortSignal): Promise<ConnectionInventory> {
  const response = await fetch(path, { method, signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `操作失败 (${response.status})`);
  return body as ConnectionInventory;
}

export default function ConnectionsPage({ onMenu, onBack }: Props) {
  const [inventory, setInventory] = useState<ConnectionInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const pending = useRef(false);
  const visible = inventory?.connections.filter(connection => `${connection.name} ${connection.host ?? ''} ${connection.username ?? ''} ${connection.type} ${connection.note ?? ''} ${kinds.find(kind => kind.type === connection.type)?.label ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const allChecks = inventory?.verification?.results ?? [];
  const failedChecks = allChecks.filter(check => !check.ok);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void request('/api/connections', 'GET', controller.signal).then(next => { if (!controller.signal.aborted) setInventory(next); }).catch(err => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取连接配置失败。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, []);

  async function update(importLocal: boolean) {
    if (pending.current || loading) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const next = await request(importLocal ? '/api/connections/import' : '/api/connections', importLocal ? 'POST' : 'GET');
      if (!alive.current) return;
      setInventory(next);
      if (importLocal) setMessage(next.connections.length ? `已同步 ${next.connections.length} 项连接配置。项目沙箱在下一轮任务开始前加载，当前任务继续运行。` : '同步完成，未发现可导入的本机连接配置。');
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : '同步失败，请重试。');
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }

  return <main className="main-pane connections-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>连接与凭据</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="connections-scroll">
      <div className="connections-heading"><div><span className="connections-eyebrow">CONNECTED WORKSPACE</span><h1>连接与凭据</h1><p>把本机已有的连接配置同步给 Agent，让沙箱访问开发所需的服务。</p></div><button className="primary-button" disabled={loading || busy} onClick={() => void update(true)}>{busy ? '处理中…' : '从本机同步凭据'}</button></div>
      {error && <p className="connections-error" role="alert">{error}</p>}
      {message && <p className="connections-message" role="status">{message}</p>}
      <section className="connections-overview" aria-label="凭据同步状态" aria-busy={loading}>
        <div className="connections-storage"><span className="connections-lock" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg></span><div><span>凭据存储</span><strong>{loading ? '正在读取…' : inventory?.configured ? '已明文保存至 .env' : inventory ? '尚未同步' : '暂未读取到配置'}</strong><p>{inventory?.importedAt ? `最近同步 ${date(inventory.importedAt)}` : '同步后以明文持久化保存在当前服务的 .env 文件中。'}</p></div></div>
        <div className="connections-scope"><span>使用范围</span><strong>所有项目沙箱</strong><p>下一轮任务生效，包含已有沙箱。</p></div>
        <div className="connections-count"><strong>{inventory?.connections.length ?? '—'}</strong><span>项连接配置</span></div>
      </section>
      <div className="connections-notice"><span aria-hidden="true">↗</span><p>沙箱支持 <code>glab</code>、<code>mysql</code>、<code>git</code>、<code>lark-cli</code>、<code>meegle</code> 和 <code>kubectl</code>。工具与凭据分别准备，凭据单独同步到沙箱，不写入模板。正在执行的任务不会被打断，工具与连接在下一轮任务启动时准备。</p></div>
      <div className="connections-toolbar"><h2>已导入的连接 <span>{inventory?.connections.length ?? 0}</span></h2><div><input type="search" aria-label="搜索连接" placeholder="搜索名称、主机或用户名" value={query} onChange={event => setQuery(event.target.value)} /><button className="secondary-button" aria-label="刷新连接" disabled={loading || busy} onClick={() => void update(false)}>刷新</button></div></div>
      {loading ? <div className="connections-empty" role="status"><span className="spinner" /> 正在读取本机同步记录…</div> : inventory && !inventory.connections.length ? <div className="connections-empty"><span className="connections-empty-symbol" aria-hidden="true">⌘</span><h2>从本机已有连接开始</h2><p>同步本机的 GitLab、数据库、Git、飞书和飞书项目配置。页面只展示连接信息，密码与令牌不会显示。</p><button className="primary-button" disabled={busy} onClick={() => void update(true)}>从本机同步凭据</button></div> : inventory && !visible.length ? <div className="connections-empty"><h2>没有匹配的连接</h2><p>试试其他名称、主机或用户名。</p></div> : <section className="connections-grid" aria-label="已导入连接列表">{kinds.filter(kind => !query.trim() || visible.some(item => item.type === kind.type)).map(kind => {
        const items = visible.filter(item => item.type === kind.type);
        return <article className="connection-card" key={kind.type} aria-label={`${kind.label} 连接`}><div className="connection-card-heading"><span className="connection-symbol" aria-hidden="true">{kind.symbol}</span><div><h2>{kind.label}</h2><code>{kind.tool}</code></div><span className="connection-card-count">{items.length} 项</span></div><p className="connection-card-description">{kind.description}</p>{!items.length ? <p className="connection-missing">尚未导入此类连接。</p> : <ul className="connection-profiles">{items.map(item => {
          const check = allChecks.find(result => result.id === item.id);
          return <li key={item.id}><div className="connection-profile-title"><strong>{item.name}</strong><span className={`connection-verification ${check ? check.ok ? 'passed' : 'failed' : ''}`}>{check ? check.ok ? '检查通过' : '检查失败' : '已导入'}</span></div><dl>{item.host && <div><dt>主机</dt><dd><code>{item.host}</code></dd></div>}{item.username && <div><dt>用户</dt><dd>{item.username}</dd></div>}</dl>{item.note && <p className="connection-profile-note">{item.note}</p>}{check && <p className={`connection-check-message ${check.ok ? '' : 'failed'}`}>{check.message}</p>}</li>;
        })}</ul>}</article>;
      })}</section>}
      {inventory?.verification && <section className="connections-checks" aria-label="最近连接验证"><div><h2>最近验证</h2><time dateTime={inventory.verification.checkedAt}>{date(inventory.verification.checkedAt)}</time></div><p>{allChecks.length ? failedChecks.length ? `${allChecks.length} 项检查中，${failedChecks.length} 项未通过。可查看连接详情并更新本机配置后重新同步。` : `${allChecks.length} 项检查全部通过。` : '暂无检查结果。'}</p></section>}
      <p className="connections-footer">本页展示连接名称、主机与用户名。同步后，Agent 可在项目沙箱中使用对应服务权限。</p>
    </div>
  </main>;
}
