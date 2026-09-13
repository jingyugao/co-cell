import { useEffect, useId, useRef } from 'react';
import type { ProjectSummary } from '../../../protocol/types';
import { projectDisplayName, projectTypeLabel } from '../../../util/project-types';
import { Icon } from '../../components/Icon';
import './ProjectPicker.css';

export default function ProjectPicker({ projects, selected, onSelect }: {
  projects: ProjectSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const id = useId();
  const active = projects.filter(project => (project.status ?? (project.archivedAt ? 'archived' : 'active')) === 'active');
  const current = active.find(project => project.id === selected);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) root.current.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  const option = (project: ProjectSummary) => <button key={project.id} type="button"
    className="project-switcher-option" aria-pressed={project.id === selected} title={projectDisplayName(project)}
    onClick={() => {
      onSelect(project.id);
      if (root.current) root.current.open = false;
      trigger.current?.focus();
    }}>
    <span>{projectDisplayName(project)}<small>{projectTypeLabel(project.type, project.weekOf)}</small></span>{project.id === selected && <Icon name="check" size={14} />}
  </button>;
  return <details className="project-switcher" ref={root}
    onKeyDown={event => {
      if (event.key === 'Escape' && root.current?.open) {
        event.preventDefault(); event.stopPropagation(); root.current.open = false; trigger.current?.focus();
      }
    }}>
    <summary ref={trigger} aria-label="切换项目" aria-controls={id} title={current?.name}>
      <span>{current?.name ?? (active.length ? '请选择项目' : '暂无进行中的项目')}</span>
      <Icon name="chevron" size={12} />
    </summary>
    <div id={id} className="project-switcher-panel" role="region" aria-label="项目列表">
      <div className="project-switcher-heading">进行中 <span>{active.length}</span></div>
      {active.length ? active.map(option) : <p className="project-switcher-empty">暂无进行中的项目</p>}
    </div>
  </details>;
}
