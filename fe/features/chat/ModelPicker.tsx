import { useRef, useState } from 'react';
import { MODEL_OPTIONS } from '../../../util/models';
import type { ModelOption } from '../../../protocol/model-types';
import { errorMessage } from '../../lib/api';
import './ModelPicker.css';

export default function ModelPicker({ model, modelEntryId, effort, disabled, onChange, models, modelOptions }: {
  model: string;
  modelEntryId?: string;
  effort: string;
  disabled: boolean;
  onChange: (model: string, modelEntryId?: string) => Promise<void>;
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
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await onChange(nextModel, nextId);
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
    {error && <div className="model-picker-error" role="alert">{error}</div>}
  </div>;
}
