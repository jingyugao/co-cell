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
  const globalDefault = images.find(image => image.versions.some(version => version.isDefault));
  const categories = [...new Set(usable.map(image => image.category))];
  function selectTemplate(id: string) {
    const image = usable.find(value => value.id === id);
    setImageId(image?.id ?? '');
    onChange(image ? { imageId: image.id, imageVersionId: 'latest' } : undefined);
  }
  return <fieldset className="image-picker" disabled={disabled}><legend>项目镜像</legend>
    <label>镜像类型<select aria-label="镜像类型" value={category} onChange={event => { setCategory(event.target.value); setImageId(''); onChange(undefined); }}><option value="">系统默认镜像{globalDefault ? ` · ${globalDefault.name}` : ''}</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
    {category && <label>镜像<select aria-label="镜像" required value={imageId} onChange={event => selectTemplate(event.target.value)}><option value="">请选择模板</option>{usable.filter(image => image.category === category).map(image => <option key={image.id} value={image.id}>{image.name}</option>)}</select></label>}
    <p className="project-form-hint">{category
      ? '新建 Sandbox 自动使用所选镜像的最新成功版本，跳过构建中、失败和已退休版本。已有 Sandbox 保持原版本。'
      : `新项目默认使用${globalDefault ? ` ${globalDefault.name} 的` : '默认镜像的'}最新成功版本；新版本构建成功后自动生效，无需重新设置默认版本。已有 Sandbox 保持原版本。`}</p>
    {error && <p className="project-error" role="alert">{error}，仍可使用系统默认镜像。</p>}
  </fieldset>;
}
