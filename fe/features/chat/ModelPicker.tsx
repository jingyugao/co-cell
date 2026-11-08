import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MODEL_OPTIONS } from '../../../util/models';
import type { ModelOption } from '../../../protocol/model-types';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';
import { useMobileLayout } from './useMobileViewport';
import './ModelPicker.css';

function ModelSheet({ children, busy, onClose }: { children: ReactNode; busy: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} className="model-sheet" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => {
      if (busy || event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="model-sheet-heading"><h2 id={titleId}>模型与模式</h2><button type="button" aria-label="关闭模型选择" disabled={busy} onClick={onClose}><Icon name="close" size={20} /></button></header>
    <div className="model-sheet-body">{children}</div>
  </dialog>, document.body);
}

export default function ModelPicker({ model, modelEntryId, effort, disabled, collaborationMode = 'default', fastMode = false, onChange, onSettingsChange, models, modelOptions }: {
  model: string;
  modelEntryId?: string;
  effort: string;
  disabled: boolean;
  collaborationMode?: 'default' | 'plan';
  fastMode?: boolean;
  onChange: (model: string, modelEntryId?: string) => Promise<void>;
  onSettingsChange: (patch: { collaborationMode?: 'default' | 'plan'; fastMode?: boolean }) => Promise<void>;
  models?: readonly string[];
  modelOptions?: readonly ModelOption[];
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const mobile = useMobileLayout();
  const radioName = useId();
  const saving = useRef(false);
  useEffect(() => { if (!mobile) setOpen(false); }, [mobile]);

  async function changeModel(value: string) {
    const option = modelOptions?.find(item => item.id === value);
    const nextModel = option?.model ?? value;
    const nextId = option?.id;
    if (disabled || saving.current || (nextId ? nextId === modelEntryId : nextModel === model && !modelEntryId)) return;
    if (await changeSetting(() => onChange(nextModel, nextId))) setOpen(false);
  }

  async function changeSetting(change: () => Promise<void>) {
    if (disabled || saving.current) return;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await change();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  const managed = modelOptions !== undefined;
  const options = models?.length ? models : MODEL_OPTIONS;
  const selectedValue = managed ? modelEntryId || '' : model;
  if (mobile) {
    const choices = managed ? modelOptions.map(option => ({ value: option.id, model: option.model, channel: option.channelName }))
      : options.map(value => ({ value, model: value, channel: '' }));
    const selected = choices.find(option => option.value === selectedValue);
    return <div className="model-picker model-picker-compact" aria-busy={pending}>
      <button type="button" className="model-picker-trigger" aria-label={`选择模型与模式，当前 ${model}${selected?.channel ? `，${selected.channel}` : ''}`} aria-haspopup="dialog" aria-expanded={open}
        title={selected?.channel ? `${model}（${selected.channel}）` : model} disabled={disabled || pending} onClick={() => setOpen(true)}>
        <span className="model-picker-summary"><span className="model-picker-name">{model || '选择模型'}</span><span className="model-picker-status">{pending ? '保存中…' : `${selected?.channel ? `${selected.channel} · ` : ''}${effort} · ${collaborationMode === 'plan' ? '计划' : '普通'}${fastMode ? ' · Fast' : ''}`}</span></span>
        <Icon name="chevron" size={14} />
      </button>
      {open && <ModelSheet busy={pending} onClose={() => setOpen(false)}>
        <fieldset className="model-sheet-options" disabled={disabled || pending} aria-busy={pending}>
          <legend>模型</legend>
          {!selected && <p className="model-sheet-unavailable">当前：{model || '未选择模型'}{modelEntryId ? '（不可用）' : ''}</p>}
          {choices.map(option => <label key={option.value} className={`model-sheet-option${selectedValue === option.value ? ' selected' : ''}`}>
            <input type="radio" name={radioName} value={option.value} checked={selectedValue === option.value}
              aria-label={option.channel ? `${option.model}（${option.channel}）` : option.model}
              onClick={() => { if (selectedValue === option.value) setOpen(false); }} onChange={() => void changeModel(option.value)} />
            <span><strong>{option.model}</strong>{option.channel && <small>{option.channel}</small>}</span>
            {selectedValue === option.value && <Icon name="check" size={18} />}
          </label>)}
        </fieldset>
        <fieldset className="model-sheet-settings" disabled={disabled || pending}>
          <legend>运行模式</legend>
          <div className="model-sheet-modes" role="group" aria-label="协作模式">
            <button type="button" aria-pressed={collaborationMode === 'default'} onClick={() => void changeSetting(() => onSettingsChange({ collaborationMode: 'default' }))}>普通</button>
            <button type="button" aria-pressed={collaborationMode === 'plan'} onClick={() => void changeSetting(() => onSettingsChange({ collaborationMode: 'plan' }))}>计划</button>
          </div>
          <div className="model-sheet-fast"><span><strong>Fast 模式</strong><small>优先处理，可能产生更高费用</small></span><button type="button" role="switch" aria-label="Fast 模式" aria-checked={fastMode} onClick={() => void changeSetting(() => onSettingsChange({ fastMode: !fastMode }))}><span /></button></div>
          <p className="model-sheet-effort">推理强度：{effort}<span role="status">{pending ? '保存中…' : ''}</span></p>
        </fieldset>
        {error && <p className="model-sheet-error" role="alert">{error}</p>}
      </ModelSheet>}
      {error && !open && <div className="model-picker-error" role="alert">{error}</div>}
    </div>;
  }
  return <div className="model-picker" aria-busy={pending}>
    <div className="model-picker-control">
      <select aria-label="切换模型" value={selectedValue} disabled={disabled || pending} onChange={event => void changeModel(event.target.value)}>
        {managed ? <>
          {modelEntryId && !modelOptions.some(item => item.id === modelEntryId) && <option value={modelEntryId} disabled>{model}（不可用）</option>}
          {!modelEntryId && <option value="" disabled>{model || '请选择模型'}</option>}
          {modelOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </> : <>
          {!options.includes(model) && <option value={model} disabled>{model || '本地默认模型'}</option>}
          {options.map(value => <option key={value} value={value}>{value}</option>)}
        </>}
      </select>
      <span className="model-effort">{pending ? '保存中…' : effort}</span>
    </div>
    <span className="model-picker-divider" />
    <select aria-label="协作模式" title="先讨论并形成计划，切换普通模式后执行。" className="mode-picker" value={collaborationMode} disabled={disabled || pending} onChange={event => void changeSetting(() => onSettingsChange({ collaborationMode: event.target.value as 'default' | 'plan' }))}>
      <option value="default">普通</option>
      <option value="plan">计划</option>
    </select>
    <button type="button" className={`fast-mode-toggle${fastMode ? ' enabled' : ''}`} role="switch" aria-checked={fastMode} aria-label="Fast 模式" title="优先处理，可能产生更高费用；取决于模型与渠道支持" disabled={disabled || pending} onClick={() => void changeSetting(() => onSettingsChange({ fastMode: !fastMode }))}>Fast</button>
    {error && <div className="model-picker-error" role="alert">{error}</div>}
  </div>;
}
