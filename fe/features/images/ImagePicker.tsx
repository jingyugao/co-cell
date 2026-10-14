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
  const [versionId, setVersionId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api<ManagedImage[]>('/api/images').then(next => { if (alive) setImages(next); })
      .catch(err => { if (alive) setError(err instanceof Error ? err.message : '镜像读取失败'); });
    return () => { alive = false; };
  }, []);
  const ready = (version: ManagedImage['versions'][number]) => version.status === 'succeeded' && !version.deprecatedAt && !version.cleanup && version.projectReady !== false;
  const usable = images.filter(image => image.origin !== 'profile' && image.versions.some(ready));
  const globalDefault = images.flatMap(image => image.versions.map(version => ({ image, version }))).find(entry => entry.version.isDefault && ready(entry.version));
  const categories = [...new Set(usable.map(image => image.category))];
  const selected = usable.find(image => image.id === imageId);
  const versions = selected?.versions.filter(ready) ?? [];
  return <fieldset className="image-picker" disabled={disabled}><legend>项目镜像</legend>
    <label>镜像类型<select aria-label="镜像类型" value={category} onChange={event => { setCategory(event.target.value); setImageId(''); setVersionId(''); onChange(undefined); }}><option value="">系统默认镜像{globalDefault ? ` · ${globalDefault.image.name} ${globalDefault.version.version}` : ''}</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
    {category && <><label>镜像<select aria-label="镜像" required value={imageId} onChange={event => {
      const image = usable.find(image => image.id === event.target.value);
      const version = image?.versions.find(value => value.isDefault && ready(value)) ?? image?.versions.find(value => value.id === image.defaultVersionId && ready(value)) ?? image?.versions.find(ready);
      setImageId(image?.id ?? ''); setVersionId(version?.id ?? '');
      onChange(image && version ? { imageId: image.id, imageVersionId: version.id } : undefined);
    }}><option value="">请选择镜像</option>{usable.filter(image => image.category === category).map(image => <option key={image.id} value={image.id}>{image.name}</option>)}</select></label>
    <label>版本<select aria-label="版本" required value={versionId} onChange={event => { setVersionId(event.target.value); onChange({ imageId, imageVersionId: event.target.value }); }}><option value="">请选择版本</option>{versions.map(version => {
      const repeated = versions.some(other => other.id !== version.id && other.version === version.version);
      const digest = version.image?.match(/@sha256:([a-f0-9]{64})$/)?.[1]?.slice(0, 12);
      return <option key={version.id} value={version.id}>{version.version}{version.isDefault ? ' · 默认镜像' : ''}{repeated ? ` · ${digest ?? version.id.slice(0, 12)}` : ''}</option>;
    })}</select></label></>}
    <p className="project-form-hint">{category ? '项目固定使用选中的版本；新增镜像版本不会改变已有项目。' : `未指定镜像时，新项目使用当前默认版本${globalDefault ? `：${globalDefault.image.name} · ${globalDefault.version.version}` : ''}；只预热该版本。`}</p>
    {error && <p className="project-error" role="alert">{error}，仍可使用系统默认镜像。</p>}
  </fieldset>;
}
