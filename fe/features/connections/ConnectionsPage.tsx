import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import ApiResourceManager from './ApiResourceManager';
import RoleManager from './RoleManager';
import ScriptManager from './ScriptManager';
import ToolManager from './ToolManager';
import { DraftGuardProvider, useDraftGuard } from './DraftGuard';
import type { DraftAggregate } from './DraftGuard';
import './ConnectionsPage.css';

const tabs = [
  { id: 'tools', label: '工具管理' }, { id: 'roles', label: '工具角色' },
  { id: 'scripts', label: '脚本管理' }, { id: 'resources', label: 'API 资源' },
] as const;
type Tab = typeof tabs[number]['id'];
type Props = { resourcePage: boolean; onResourcePage: (show: boolean) => boolean; onMenu: () => void; onBack: () => void; onStatusChange: (status: DraftAggregate) => void };
export default function ConnectionsPage(props: Props) {
  return <DraftGuardProvider onStatusChange={props.onStatusChange}><ConnectionsContent {...props} /></DraftGuardProvider>;
}

function ConnectionsContent({ onMenu, onBack, resourcePage, onResourcePage }: Props) {
  const [toolTab, setToolTab] = useState<Exclude<Tab, 'resources'>>('tools');
  const activeTab = resourcePage ? 'resources' : toolTab;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const draftGuard = useDraftGuard();
  function selectTab(next: Tab) {
    if (next === activeTab) return true;
    if (next === 'resources') return onResourcePage(true);
    if (resourcePage ? !onResourcePage(false) : draftGuard && !draftGuard.canLeave()) return false;
    setToolTab(next);
    return true;
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    const current = tabs.findIndex(tab => tab.id === activeTab);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (current + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    if (selectTab(tabs[next].id)) tabRefs.current[next]?.focus();
  }
  return <main className="main-pane connections-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>{resourcePage ? 'API 资源' : '连接与工具'}</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="connections-scroll">
      <div className="connections-tabs" role="tablist" aria-label="连接与工具管理">
        {tabs.map((tab, index) => <button key={tab.id} ref={element => { tabRefs.current[index] = element; }}
          id={`connections-${tab.id}-tab`} type="button" role="tab" aria-selected={activeTab === tab.id}
          aria-controls={`connections-${tab.id}-panel`} tabIndex={activeTab === tab.id ? 0 : -1}
          onKeyDown={moveTab} onClick={() => selectTab(tab.id)}>{tab.label}</button>)}
      </div>
      <section id={`connections-${activeTab}-panel`} className="connections-tab-panel" role="tabpanel" aria-labelledby={`connections-${activeTab}-tab`}>
        {activeTab === 'tools' && <ToolManager />}
        {activeTab === 'roles' && <RoleManager />}
        {activeTab === 'scripts' && <ScriptManager />}
        {activeTab === 'resources' && <ApiResourceManager />}
      </section>
    </div>
  </main>;
}
