import { useRef, useState } from 'react';
import { MODEL_OPTIONS } from '../../../util/models';
import { errorMessage } from '../../lib/api';
import './ModelPicker.css';

export default function ModelPicker({ model, effort, disabled, onChange }: {
  model: string;
  effort: string;
  disabled: boolean;
  onChange: (model: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);

  async function changeModel(value: string) {
    if (disabled || saving.current || value === model) return;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await onChange(value);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return <div className="model-picker" aria-busy={pending}>
    <div className="model-picker-control">
      <select aria-label="切换模型" value={model} disabled={disabled || pending} onChange={event => void changeModel(event.target.value)}>
        {!MODEL_OPTIONS.includes(model) && <option value={model} disabled>{model || '本地默认模型'}</option>}
        {MODEL_OPTIONS.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <span className="model-effort">{pending ? '保存中…' : effort}</span>
    </div>
    {error && <div className="model-picker-error" role="alert">{error}</div>}
  </div>;
}
