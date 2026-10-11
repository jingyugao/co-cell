import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManagedModel, ModelCatalog, ModelCatalogInput, ModelChannel, ModelChannelInput, ModelOption } from '../../../protocol/model-types';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';
import './ModelsPage.css';

type Props = { onMenu: () => void; onBack: () => void; onSaved: () => void; onDirtyChange: (dirty: boolean) => void };
const makeId = () => globalThis.crypto?.randomUUID?.() || `model-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const entryLabel = (model: string, channel: Pick<ModelChannel, 'id' | 'name'>) => `${model}（${channel.name.trim() || '未命名渠道'}）`;

export default function ModelsPage({ onMenu, onBack, onSaved, onDirtyChange }: Props) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [persistedIds, setPersistedIds] = useState<Set<string>>(new Set());
  const savedCatalog = useRef<ModelCatalog | null>(null);
  const [baseline, setBaseline] = useState('');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [discoveries, setDiscoveries] = useState<Record<string, string[]>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const options = useMemo<ModelOption[]>(() => (catalog?.channels || []).flatMap(channel => channel.enabled
    ? channel.models.filter(model => model.visible).map(model => ({ id: model.id, model: model.model, channelId: channel.id, channelName: channel.name, label: entryLabel(model.model, channel) }))
    : []), [catalog]);
  const selectedDefaultExists = options.some(option => option.id === catalog?.defaultModelId);
  const requiresDefault = Boolean(catalog && (catalog.defaultModelId || savedCatalog.current?.defaultModelId || options.length > 0));
  const defaultIsValid = !requiresDefault || selectedDefaultExists;
  const draft = JSON.stringify({ catalog, keys });
  const dirty = Boolean(catalog && baseline !== draft);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  async function load(discard = false) {
    if (!discard && dirty && !window.confirm('重新加载会放弃尚未保存的模型配置，确定继续吗？')) return;
    setError(''); setNotice('');
    try {
      const loaded = await api<ModelCatalog>('/api/models');
      savedCatalog.current = loaded; setCatalog(loaded); setPersistedIds(new Set(loaded.channels.map(channel => channel.id))); setKeys({});
      setBaseline(JSON.stringify({ catalog: loaded, keys: {} }));
    } catch (err) { setError(errorMessage(err)); }
  }
  useEffect(() => { void load(true); }, []);

  function updateChannel(id: string, patch: Partial<ModelChannel>) {
    setCatalog(current => {
      if (!current) return current;
      const channel = current.channels.find(item => item.id === id);
      const clearDefault = patch.enabled === false && channel?.models.some(model => model.id === current.defaultModelId);
      return { ...current, defaultModelId: clearDefault ? null : current.defaultModelId, channels: current.channels.map(item => item.id === id ? { ...item, ...patch } : item) };
    });
  }
  function updateModel(channelId: string, id: string, patch: Partial<ManagedModel>) {
    setCatalog(current => current && ({ ...current, defaultModelId: patch.visible === false && current.defaultModelId === id ? null : current.defaultModelId, channels: current.channels.map(channel => channel.id === channelId ? { ...channel, models: channel.models.map(model => model.id === id ? { ...model, ...patch } : model) } : channel) }));
  }
  function addChannel() {
    const id = makeId();
    setCatalog(current => current && ({ ...current, channels: [...current.channels, { id, name: '', endpoint: '', enabled: true, hasApiKey: false, models: [] }] }));
  }
  function addModel(channelId: string, modelName: string) {
    const model = modelName.trim();
    if (!model) return;
    const channel = catalog?.channels.find(item => item.id === channelId);
    if (!channel || channel.models.some(item => item.model === model)) return;
    const entry: ManagedModel = { id: makeId(), model, visible: true };
    setCatalog(current => {
      if (!current) return current;
      const owner = current.channels.find(item => item.id === channelId);
      return { ...current, defaultModelId: current.defaultModelId || (owner?.enabled ? entry.id : null), channels: current.channels.map(item => item.id === channelId ? { ...item, models: [...item.models, entry] } : item) };
    });
  }
  function usesSavedSettings(channel: ModelChannel) {
    const saved = savedCatalog.current?.channels.find(item => item.id === channel.id);
    return Boolean(persistedIds.has(channel.id) && saved && saved.enabled === channel.enabled && channel.name === saved.name && channel.endpoint === saved.endpoint && !keys[channel.id]?.trim());
  }
  async function discover(channel: ModelChannel) {
    setNotice(''); setError('');
    try {
      const response = await api<{ models: string[] }>(`/api/models/channels/${encodeURIComponent(channel.id)}/discover`, { method: 'POST' });
      setDiscoveries(previous => ({ ...previous, [channel.id]: response.models }));
      setNotice(`已获取 ${response.models.length} 个模型；勾选后才会加入可选列表。`);
    } catch (err) { setError(errorMessage(err)); }
  }
  async function test(channel: ModelChannel) {
    setTesting(channel.id); setError(''); setNotice('');
    try {
      await api<{ ok: true }>(`/api/models/channels/${encodeURIComponent(channel.id)}/test`, { method: 'POST', body: JSON.stringify({}) });
      setNotice(`“${channel.name || '未命名渠道'}”连接测试成功。`);
    } catch (err) { setError(errorMessage(err)); }
    finally { setTesting(null); }
  }
  async function save() {
    if (!catalog) return;
    setBusy(true); setError(''); setNotice('');
    const input: ModelCatalogInput = {
      revision: catalog.revision,
      defaultModelId: catalog.defaultModelId,
      channels: catalog.channels.map(channel => {
        const result: ModelChannelInput = { id: channel.id, name: channel.name.trim(), endpoint: channel.endpoint.trim(), enabled: channel.enabled, models: channel.models };
        if (keys[channel.id]?.trim()) result.apiKey = keys[channel.id].trim();
        return result;
      }),
    };
    try {
      const saved = await api<ModelCatalog>('/api/models', { method: 'PUT', body: JSON.stringify(input) });
      savedCatalog.current = saved; setCatalog(saved); setPersistedIds(new Set(saved.channels.map(channel => channel.id))); setKeys({}); setDiscoveries({}); setBaseline(JSON.stringify({ catalog: saved, keys: {} })); setNotice('模型配置已保存。'); onSaved();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }

  return <main className="main-pane models-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button><div className="breadcrumbs"><span>系统管理</span><span className="slash">/</span><strong>模型管理</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="models-scroll"><div className="models-content">
      <section className="models-heading"><div><span className="models-eyebrow">MODEL ROUTING</span><h1>模型管理</h1><p>配置模型渠道、选择可用模型，并设置新会话的默认模型。</p></div><div className="models-heading-actions"><button className="secondary-button" disabled={busy} onClick={() => void load()}>重新加载配置</button><button className="primary-button" disabled={!catalog || busy || !defaultIsValid} onClick={() => void save()}>{busy ? '保存中…' : '保存配置'}</button></div></section>
      {error && <div className="inline-error" role="alert">{error}</div>}{notice && <div className="models-notice" role="status">{notice}</div>}
      {!catalog ? <div className="models-loading">{error ? '模型配置暂不可用。' : '正在读取模型配置…'} <button className="secondary-button" onClick={() => void load(true)}>重试</button></div> : <>
        <fieldset className="models-editor" disabled={busy}>
        <section className="models-panel default-model-panel"><div><h2>默认模型</h2><p>新会话会预选此模型；已有会话不受影响。</p></div><label className="models-default-select"><span>默认模型</span><select aria-label="默认模型" value={catalog.defaultModelId || ''} onChange={event => setCatalog(current => current && ({ ...current, defaultModelId: event.target.value || null }))}><option value="">未设置</option>{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>{!selectedDefaultExists && catalog.defaultModelId && <small>当前默认模型已隐藏或渠道已停用，请重新选择。</small>}</label></section>
        {requiresDefault && !selectedDefaultExists && <div className="models-default-warning" role="alert">{options.length > 0 ? '当前默认模型不可用，请为已启用且可见的模型选择一个默认模型后再保存。' : '请至少保留一个已启用且可见的模型，并将其设为默认模型。当前没有可用项，请重新勾选模型或启用渠道。'}</div>}
        <section className="models-section-heading"><div><h2>渠道配置</h2><p>每个渠道有独立的 Endpoint 和 API Key。密钥只写入，不会再次显示。</p></div><button className="secondary-button" onClick={addChannel}><Icon name="plus" size={15} />添加渠道</button></section>
        {!catalog.channels.length && <div className="models-empty">尚未配置模型渠道。添加渠道后，可获取模型列表或手动添加模型。</div>}
        <div className="model-channels">{catalog.channels.map((channel, index) => <ChannelCard key={channel.id} channel={channel} index={index} apiKey={keys[channel.id] || ''} discovered={discoveries[channel.id] || []} options={options} defaultModelId={catalog.defaultModelId} busy={busy} persisted={persistedIds.has(channel.id)} savedSettings={usesSavedSettings(channel)} testing={testing === channel.id} onChange={patch => updateChannel(channel.id, patch)} onApiKey={value => setKeys(previous => ({ ...previous, [channel.id]: value }))} onAddModel={name => addModel(channel.id, name)} onUpdateModel={(id, patch) => updateModel(channel.id, id, patch)} onDiscover={() => void discover(channel)} onTest={() => void test(channel)} onDefault={id => setCatalog(current => current && ({ ...current, defaultModelId: id }))} />)}</div>
        </fieldset>
      </>}
    </div></div>
  </main>;
}

function ChannelCard({ channel, index, apiKey, discovered, options, defaultModelId, busy, persisted, savedSettings, testing, onChange, onApiKey, onAddModel, onUpdateModel, onDiscover, onTest, onDefault }: {
  channel: ModelChannel; index: number; apiKey: string; discovered: string[]; options: ModelOption[]; defaultModelId: string | null; busy: boolean; persisted: boolean; savedSettings: boolean; testing: boolean;
  onChange: (patch: Partial<ModelChannel>) => void; onApiKey: (value: string) => void; onAddModel: (model: string) => void; onUpdateModel: (id: string, patch: Partial<ManagedModel>) => void; onDiscover: () => void; onTest: () => void; onDefault: (id: string) => void;
}) {
  const [manual, setManual] = useState('');
  const [filter, setFilter] = useState('');
  const visibleOptions = options.filter(option => option.channelId === channel.id);
  const candidates = discovered.filter(name => !channel.models.some(model => model.model === name));
  const addManual = () => { onAddModel(manual); setManual(''); };
  return <article className="model-channel-card">
    <div className="model-channel-title"><div><span className="channel-index">渠道 {String(index + 1).padStart(2, '0')}</span><h3>{channel.name.trim() || '新渠道'}</h3><span className={`channel-status ${channel.enabled ? 'active' : ''}`}>{channel.enabled ? '已启用' : '已停用'}</span></div><label className="channel-toggle"><input type="checkbox" checked={channel.enabled} onChange={event => onChange({ enabled: event.target.checked })} /><span>启用渠道</span></label></div>
    <div className="model-channel-fields"><label>渠道名称<input maxLength={80} value={channel.name} onChange={event => onChange({ name: event.target.value })} placeholder="例如：官方 / 渠道 A" /></label><label>Endpoint<input maxLength={2048} value={channel.endpoint} onChange={event => onChange({ endpoint: event.target.value })} placeholder="https://api.example.com/v1" /></label><label>API Key<input type="password" autoComplete="new-password" value={apiKey} onChange={event => onApiKey(event.target.value)} placeholder={channel.hasApiKey ? '已配置，留空则保留当前密钥' : '输入 API Key'} /></label></div>
    <div className="channel-actions"><span>{channel.hasApiKey && !apiKey ? 'API Key 已配置' : 'API Key 未配置'}</span><div><button className="secondary-button" disabled={busy || testing || !channel.enabled || !savedSettings} title="测试会发送一次最小请求，可能产生少量费用" onClick={onTest}>{testing ? '测试中…' : '测试连接'}</button><button className="secondary-button" disabled={busy || !channel.enabled || !savedSettings} onClick={onDiscover}>获取模型</button></div></div>{persisted && !channel.enabled && <small className="model-test-hint">启用渠道后再测试/获取模型。</small>}{persisted && channel.enabled && !savedSettings && <small className="model-test-hint">先保存修改后再测试/获取模型。</small>}{persisted && channel.enabled && savedSettings && <small className="model-test-hint">连接测试会发送一次最小请求，可能产生少量费用。</small>}{!persisted && <small className="model-test-hint">先保存渠道，再测试连接或获取模型。</small>}
    <div className="channel-models"><div className="channel-model-heading"><div><h4>模型列表</h4><span>勾选的模型会显示在会话选择器中</span></div><span>{visibleOptions.length} 个可选</span></div>
      {channel.models.length > 5 && <input className="model-filter" aria-label={`${channel.name} 模型筛选`} value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选模型…" />}
      {!channel.models.length && <p className="channel-model-empty">还没有模型。可以先获取列表，或手动添加模型 ID。</p>}
      <div className="managed-model-list">{channel.models.filter(item => item.model.toLowerCase().includes(filter.toLowerCase())).map(model => <div className="managed-model-row" key={model.id}><label><input type="checkbox" checked={model.visible} onChange={event => onUpdateModel(model.id, { visible: event.target.checked })} /><span>{model.model}</span></label><button className={`model-default-star ${defaultModelId === model.id ? 'selected' : ''}`} aria-label={`设为默认模型：${model.model}（${channel.name}）`} title="设为默认模型" disabled={!model.visible || !channel.enabled} onClick={() => onDefault(model.id)}>★</button></div>)}</div>
      {candidates.length > 0 && <div className="discovered-models"><strong>新发现的模型</strong><div>{candidates.map(model => <label key={model}><input type="checkbox" onChange={event => { if (event.target.checked) onAddModel(model); }} /><span>{model}</span></label>)}</div></div>}
      <form className="manual-model-form" onSubmit={event => { event.preventDefault(); addManual(); }}><input aria-label="手动添加模型 ID" maxLength={200} value={manual} onChange={event => setManual(event.target.value)} placeholder="手动输入模型 ID" /><button className="secondary-button" type="submit" disabled={!manual.trim() || channel.models.some(model => model.model === manual.trim())}>添加模型</button></form>
    </div>
  </article>;
}
