import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { MODEL_OPTIONS } from '../../../util/models';
import type { ModelOption } from '../../../protocol/model-types';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../components/Icon';
import './ModelPicker.css';

function ModelMenu({ children, busy, anchor, onClose }: { children: ReactNode; busy: boolean; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const position = () => {
      const trigger = anchor.current;
      if (!trigger) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const rect = trigger.getBoundingClientRect();
      const above = rect.top - top - 20, below = top + height - rect.bottom - 20;
      const opensAbove = above >= below;
      dialog.style.width = `${Math.min(344, width - 24)}px`;
      dialog.style.maxHeight = `${Math.max(0, Math.min(560, opensAbove ? above : below))}px`;
      dialog.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - dialog.offsetWidth - 12))}px`;
      dialog.style.top = `${opensAbove ? Math.max(top + 12, rect.top - dialog.offsetHeight - 8) : rect.bottom + 8}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(dialog);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [anchor]);
  return createPortal(<dialog ref={ref} className="model-menu" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => {
      if (busy || event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="model-menu-heading"><h2 id={titleId}>模型与模式</h2><button type="button" aria-label="关闭模型选择" disabled={busy} onClick={onClose}><Icon name="close" size={20} /></button></header>
    <div className="model-menu-body">{children}</div>
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
  const trigger = useRef<HTMLButtonElement>(null);
  const radioName = useId();
  const saving = useRef(false);

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
  const choices = managed ? modelOptions.map(option => ({ value: option.id, model: option.model, channel: option.channelName }))
    : options.map(value => ({ value, model: value, channel: '' }));
  const selected = choices.find(option => option.value === selectedValue);
  return <div className="model-picker model-picker-compact" aria-busy={pending}>
    <button ref={trigger} type="button" className="model-picker-trigger" aria-label={`选择模型与模式，当前 ${model}${selected?.channel ? `，${selected.channel}` : ''}${collaborationMode === 'plan' ? '，计划模式' : ''}${fastMode ? '，Fast 模式已开启' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      title={selected?.channel ? `${model}（${selected.channel}）` : model} disabled={disabled || pending} onClick={() => setOpen(true)}>
      <span className="model-picker-summary"><span className="model-picker-name">{model || '选择模型'}</span>{(pending || selected?.channel) && <span className="model-picker-status">{pending ? '保存中…' : selected?.channel}</span>}</span>
      {(collaborationMode === 'plan' || fastMode) && <span className="model-picker-badge">{[collaborationMode === 'plan' && '计划', fastMode && 'Fast'].filter(Boolean).join(' · ')}</span>}
      <Icon name="chevron" size={14} />
    </button>
    {open && <ModelMenu anchor={trigger} busy={pending} onClose={() => setOpen(false)}>
      <fieldset className="model-menu-options" disabled={disabled || pending} aria-busy={pending}>
        <legend>模型</legend>
        {!selected && <p className="model-menu-unavailable">当前：{model || '未选择模型'}{modelEntryId ? '（不可用）' : ''}</p>}
        {choices.map(option => <label key={option.value} className={`model-menu-option${selectedValue === option.value ? ' selected' : ''}`}>
          <input type="radio" name={radioName} value={option.value} checked={selectedValue === option.value}
            aria-label={option.channel ? `${option.model}（${option.channel}）` : option.model}
            onClick={() => { if (selectedValue === option.value) setOpen(false); }} onChange={() => void changeModel(option.value)} />
          <span><strong>{option.model}</strong>{option.channel && <small>{option.channel}</small>}</span>
          {selectedValue === option.value && <Icon name="check" size={18} />}
        </label>)}
      </fieldset>
      <details className="model-menu-settings">
        <summary>运行模式<span>{collaborationMode === 'plan' ? '计划' : '普通'}{fastMode ? ' · Fast' : ''}</span><Icon name="chevron" size={14} /></summary>
        <fieldset disabled={disabled || pending}>
          <div className="model-menu-modes" role="group" aria-label="协作模式">
            <button type="button" aria-pressed={collaborationMode === 'default'} onClick={() => void changeSetting(() => onSettingsChange({ collaborationMode: 'default' }))}>普通</button>
            <button type="button" aria-pressed={collaborationMode === 'plan'} onClick={() => void changeSetting(() => onSettingsChange({ collaborationMode: 'plan' }))}>计划</button>
          </div>
          <div className="model-menu-fast"><span><strong>Fast 模式</strong><small>优先处理，可能产生更高费用</small></span><button type="button" role="switch" aria-label="Fast 模式" aria-checked={fastMode} onClick={() => void changeSetting(() => onSettingsChange({ fastMode: !fastMode }))}><span /></button></div>
          <p className="model-menu-effort">推理强度：{effort}<span role="status">{pending ? '保存中…' : ''}</span></p>
        </fieldset>
      </details>
      {error && <p className="model-menu-error" role="alert">{error}</p>}
    </ModelMenu>}
    {error && !open && <div className="model-picker-error" role="alert">{error}</div>}
  </div>;
}
