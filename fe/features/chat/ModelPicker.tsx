import { useRef, useState } from 'react';
import { MODEL_OPTIONS } from '../../../util/models';
import type { ModelOption } from '../../../protocol/model-types';
import { errorMessage } from '../../lib/api';
import './ModelPicker.css';

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
  const saving = useRef(false);

  async function changeModel(value: string) {
    const option = modelOptions?.find(item => item.id === value);
    const nextModel = option?.model ?? value;
    const nextId = option?.id;
    if (disabled || saving.current || (nextId ? nextId === modelEntryId : nextModel === model && !modelEntryId)) return;
    await changeSetting(() => onChange(nextModel, nextId));
  }

  async function changeSetting(change: () => Promise<void>) {
    if (disabled || saving.current) return;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await change();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  const managed = modelOptions !== undefined;
  const options = models?.length ? models : MODEL_OPTIONS;
  const selectedValue = managed ? modelEntryId || '' : model;
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
