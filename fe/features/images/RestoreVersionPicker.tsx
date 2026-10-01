import { useEffect, useState } from 'react';
import type { ManagedImage } from '../../../protocol/image-types';
import { api } from '../../lib/api';

export default function RestoreVersionPicker({ imageId, disabled, value, onChange }: {
  imageId: string; disabled: boolean; value: string; onChange: (value: string) => void;
}) {
  const [image, setImage] = useState<ManagedImage>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api<ManagedImage[]>('/api/images').then(images => {
      if (alive) setImage(images.find(image => image.id === imageId));
    }).catch(error => { if (alive) setError(error instanceof Error ? error.message : '版本读取失败'); });
    return () => { alive = false; };
  }, [imageId]);
  return <label className="project-rebuild-hint">恢复镜像版本
    <select aria-label="恢复镜像版本" disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">仓库默认版本</option>
      {image?.versions.filter(version => version.status === 'succeeded' && !version.cleanup && version.projectReady !== false).map(version =>
        <option value={version.id} key={version.id}>{version.version}{version.id === image.defaultVersionId ? '（默认）' : ''} · {new Date(version.createdAt).toLocaleString('zh-CN', { hour12: false })}</option>)}
    </select>{error && <span role="alert">{error}</span>}
  </label>;
}
