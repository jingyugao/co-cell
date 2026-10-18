import { useEffect, useState } from 'react';
import type { ManagedImage } from '../../../protocol/image-types';
import { api } from '../../lib/api';
import './ImagesPage.css';

export default function ImagePicker({ disabled, onChange }: {
  disabled: boolean; onChange: (selection: { imageId: string; imageVersionId: string } | undefined) => void;
}) {
  const [images, setImages] = useState<ManagedImage[]>([]);
  const [category, setCategory] = useState('');
  const [imageId, setImageId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api<ManagedImage[]>('/api/images').then(next => { if (alive) setImages(next); })
      .catch(err => { if (alive) setError(err instanceof Error ? err.message : '镜像读取失败'); });
    return () => { alive = false; };
  }, []);
  const ready = (version: ManagedImage['versions'][number]) => version.status === 'succeeded' && !version.deprecatedAt && !version.cleanup && !version.migrationRequired && version.projectReady !== false;
  const usable = images.filter(image => image.origin !== 'profile' && image.versions.some(ready));
  const globalDefault = images.flatMap(image => image.versions.map(version => ({ image, version }))).find(entry => entry.version.isDefault && ready(entry.version));
  const categories = [...new Set(usable.map(image => image.category))];
  function selectTemplate(id: string) {
    const image = usable.find(value => value.id === id);
    const entry = image?.versions.find(value => value.id === image.defaultVersionId && ready(value))
      ?? image?.versions.find(value => value.isDefault && ready(value))
      ?? image?.versions.find(ready);
    setImageId(image?.id ?? '');
    onChange(image && entry ? { imageId: image.id, imageVersionId: entry.id } : undefined);
  }
  return <fieldset className="image-picker" disabled={disabled}><legend>项目镜像</legend>
    <label>镜像类型<select aria-label="镜像类型" value={category} onChange={event => { setCategory(event.target.value); setImageId(''); onChange(undefined); }}><option value="">系统默认镜像{globalDefault ? ` · ${globalDefault.image.name}` : ''}</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
    {category && <label>镜像<select aria-label="镜像" required value={imageId} onChange={event => selectTemplate(event.target.value)}><option value="">请选择模板</option>{usable.filter(image => image.category === category).map(image => <option key={image.id} value={image.id}>{image.name}</option>)}</select></label>}
    <p className="project-form-hint">{category
      ? '这里选择 Cellbox template，不固定镜像版本；新建 Sandbox 时使用该 template 当前的 stable revision。已有 Sandbox 不受影响。'
      : `未指定镜像时，新项目使用 CoCell 默认 template${globalDefault ? `：${globalDefault.image.name}` : '（尚未配置）'}；新建 Sandbox 时使用该 template 当前的 stable revision。CoCell 默认选择只决定 template，不修改 Cellbox stable 或 warmSlots。`}</p>
    {error && <p className="project-error" role="alert">{error}，仍可使用系统默认镜像。</p>}
  </fieldset>;
}
