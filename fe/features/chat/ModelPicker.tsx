import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MODEL_OPTIONS } from '../../../util/models';
import type { ModelOption } from '../../../protocol/model-types';
import type { Settings } from '../../../protocol/types';
import { errorMessage } from '../../lib/api';
import './ModelPicker.css';

type ModelSettings = Pick<Settings, 'model' | 'modelEntryId' | 'modelReasoningEffort' | 'fastMode'>;
const efforts: Record<Settings['modelReasoningEffort'], string> = {
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra', persistent: 'Persistent',
};

function SelectArrows() {
  return <svg className="model-config-arrows" width="14" height="18" viewBox="0 0 14 18" fill="none" aria-hidden="true"><path d="m4 6 3-3 3 3M4 12l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ModelConfiguration({ current, defaults, choices, managed, disabled, onSave, onClose }: {
  current: ModelSettings; defaults?: ModelSettings; choices: readonly ModelOption[]; managed: boolean; disabled: boolean;
  onSave: (patch: Partial<ModelSettings>) => Promise<void>; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  async function save() {
    if (disabled || saving.current) return;
    const patch: Partial<ModelSettings> = {};
    if (draft.model !== current.model || draft.modelEntryId !== current.modelEntryId) {
      patch.model = draft.model;
      patch.modelEntryId = draft.modelEntryId;
    }
    if (draft.modelReasoningEffort !== current.modelReasoningEffort) patch.modelReasoningEffort = draft.modelReasoningEffort;
    if (Boolean(draft.fastMode) !== Boolean(current.fastMode)) patch.fastMode = Boolean(draft.fastMode);
    if (!Object.keys(patch).length) { onClose(); return; }
    saving.current = true;
    setPending(true);
    setError('');
    try { await onSave(patch); onClose(); }
    catch (err) { setError(errorMessage(err)); }
    finally { saving.current = false; setPending(false); }
  }

  const value = managed ? draft.modelEntryId || '' : draft.model;
  const selected = choices.find(option => option.id === value);
  const locked = disabled || pending;
  return createPortal(<dialog ref={ref} className="model-config" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}
    onClick={event => {
      if (pending || event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className="model-config-handle" aria-hidden="true" />
    <h2 id={titleId}>配置</h2>
    <form onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={pending}>
      <fieldset className="model-config-fields" disabled={locked}>
        <label className="model-config-row"><span>模型</span><span className="model-config-value" title={selected?.label || draft.model}>{selected?.label || draft.model || '选择模型'}</span><SelectArrows />
          <select aria-label="模型" value={value} onChange={event => {
            const choice = choices.find(option => option.id === event.target.value);
            if (choice) setDraft(previous => ({ ...previous, model: choice.model, modelEntryId: managed ? choice.id : undefined }));
          }}>
            {!selected && <option value={value} disabled>{draft.model || '请选择模型'}{draft.modelEntryId ? '（不可用）' : ''}</option>}
            {choices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <label className="model-config-row"><span>推理强度</span><span className="model-config-value">{efforts[draft.modelReasoningEffort]}</span><SelectArrows />
          <select aria-label="推理强度" value={draft.modelReasoningEffort} onChange={event => setDraft(previous => ({ ...previous, modelReasoningEffort: event.target.value as Settings['modelReasoningEffort'] }))}>
            {Object.entries(efforts).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="model-config-row"><span>速度</span><span className="model-config-value">{draft.fastMode ? 'Fast' : 'Standard'}</span><SelectArrows />
          <select aria-label="速度" value={draft.fastMode ? 'fast' : 'standard'} onChange={event => setDraft(previous => ({ ...previous, fastMode: event.target.value === 'fast' }))}>
            <option value="standard">Standard</option><option value="fast">Fast · 优先处理，可能产生更高费用</option>
          </select>
        </label>
      </fieldset>
      <button className="model-config-reset" type="button" disabled={locked || !defaults} onClick={() => { if (defaults) setDraft({ ...defaults }); }}>恢复默认</button>
      {error && <p className="model-config-error" role="alert">{error}</p>}
      <button className="model-config-done" type="submit" disabled={locked}>{pending ? '保存中…' : '完成'}</button>
    </form>
  </dialog>, document.body);
}

export default function ModelPicker({ model, modelEntryId, effort, disabled, fastMode = false, defaults, onSettingsChange, models, modelOptions }: {
  model: string; modelEntryId?: string; effort: Settings['modelReasoningEffort']; disabled: boolean; fastMode?: boolean;
  defaults?: ModelSettings; onSettingsChange: (patch: Partial<ModelSettings>) => Promise<void>;
  models?: readonly string[]; modelOptions?: readonly ModelOption[];
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const managed = modelOptions !== undefined;
  const choices = modelOptions ?? (models?.length ? models : MODEL_OPTIONS).map(value => ({ id: value, model: value, label: value, channelId: '', channelName: '' }));
  const selected = choices.find(option => option.id === (managed ? modelEntryId : model));
  return <div className="model-picker">
    <button ref={trigger} type="button" className="model-picker-trigger" aria-label={`配置模型，当前 ${model}${selected?.channelName ? `，${selected.channelName}` : ''}，${efforts[effort]}${fastMode ? '，Fast' : ''}`}
      aria-haspopup="dialog" aria-expanded={open} title={selected?.label || model} disabled={disabled} onClick={() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        trigger.current?.focus({ preventScroll: true });
        setOpen(true);
      }}>
      <span className="model-picker-name">{model || '选择模型'}</span><span className="model-picker-effort">{efforts[effort]}</span>
    </button>
    {open && <ModelConfiguration current={{ model, modelEntryId, modelReasoningEffort: effort, fastMode }} defaults={defaults} choices={choices} managed={managed}
      disabled={disabled} onSave={onSettingsChange} onClose={() => setOpen(false)} />}
  </div>;
}
