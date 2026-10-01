import { useRef, useState } from 'react';
import type { AddImageRepositoryInput } from '../../../protocol/image-types';

export default function RepositoryForm({ categories, busy, onSubmit, onCancel }: {
  categories: string[]; busy: boolean; onSubmit: (input: AddImageRepositoryInput) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('开发环境');
  const [repository, setRepository] = useState('');
  const [buildCommand, setBuildCommand] = useState('');
  const [privateRegistry, setPrivateRegistry] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  return <form className="project-form image-import-form" aria-label="添加镜像仓库" onSubmit={async event => {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setError('');
    try {
      await onSubmit({ name: name.trim(), category: category.trim(), repository: repository.trim(),
        registryAuthRequired: privateRegistry, ...(buildCommand.trim() ? { buildCommand } : {}) });
    } catch (err) { setError(err instanceof Error ? err.message : '仓库添加失败，请重试'); }
    finally { pending.current = false; }
  }}>
    <h2>添加镜像仓库</h2>
    <div className="image-form-row"><label>镜像类型<input required maxLength={100} list="image-categories" value={category} disabled={busy} onChange={event => setCategory(event.target.value)} /><datalist id="image-categories">{categories.map(value => <option key={value} value={value} />)}</datalist></label><label>仓库名称<input required maxLength={100} value={name} disabled={busy} placeholder="例如：Python 开发环境" onChange={event => setName(event.target.value)} /></label></div>
    <label>镜像仓库地址<input aria-label="镜像仓库地址" required maxLength={2048} value={repository} disabled={busy} placeholder="docker.io/team/image 或 registry.example.com/team/image" onChange={event => setRepository(event.target.value)} /><small>支持 Docker Hub 仓库网页链接。不填写 Tag；HTTP 仓库请明确填写 http://。</small></label>
    <label>构建命令（可选）<textarea rows={5} value={buildCommand} disabled={busy} placeholder="同步每个版本时，在源镜像中安装或复制所需工具" onChange={event => setBuildCommand(event.target.value)} /></label>
    <label className="image-checkbox"><input type="checkbox" checked={privateRegistry} disabled={busy} onChange={event => setPrivateRegistry(event.target.checked)} />私有仓库认证</label>
    <p className="project-form-hint">添加仓库后进入版本页面，选择上游 Tag 同步；每个版本都使用此构建命令。</p>
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="project-form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="primary-button" disabled={busy}>{busy ? '添加中…' : '添加并进入仓库'}</button></div>
  </form>;
}
