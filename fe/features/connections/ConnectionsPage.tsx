import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import RoleManager from './RoleManager';
import ScriptManager from './ScriptManager';
import ToolManager from './ToolManager';
import { DraftGuardProvider, useDraftGuard } from './DraftGuard';
import type { DraftAggregate } from './DraftGuard';
import './ConnectionsPage.css';

type Props = { onMenu: () => void; onBack: () => void; onStatusChange: (status: DraftAggregate) => void };
export default function ConnectionsPage(props: Props) {
  return <DraftGuardProvider onStatusChange={props.onStatusChange}><ConnectionsContent {...props} /></DraftGuardProvider>;
}

function ConnectionsContent({ onMenu, onBack }: Props) {
  const [activeTab, setActiveTab] = useState<'tools' | 'roles' | 'scripts'>('tools');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const draftGuard = useDraftGuard();
  function selectTab(next: 'tools' | 'roles' | 'scripts') {
    if (next === activeTab || draftGuard?.canLeave()) setActiveTab(next);
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    const tabs = ['tools', 'roles', 'scripts'] as const;
    const current = tabs.indexOf(activeTab);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (current + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    if (next === current || draftGuard?.canLeave()) { setActiveTab(tabs[next]); tabRefs.current[next]?.focus(); }
  }
  return <main className="main-pane connections-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>连接与工具</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="connections-scroll">
      <div className="connections-tabs" role="tablist" aria-label="连接与工具管理">
        <button ref={element => { tabRefs.current[0] = element; }} id="connections-tools-tab" type="button" role="tab" aria-selected={activeTab === 'tools'} aria-controls="connections-tools-panel" tabIndex={activeTab === 'tools' ? 0 : -1} onKeyDown={moveTab} onClick={() => selectTab('tools')}>工具管理</button>
        <button ref={element => { tabRefs.current[1] = element; }} id="connections-roles-tab" type="button" role="tab" aria-selected={activeTab === 'roles'} aria-controls="connections-roles-panel" tabIndex={activeTab === 'roles' ? 0 : -1} onKeyDown={moveTab} onClick={() => selectTab('roles')}>工具角色</button>
        <button ref={element => { tabRefs.current[2] = element; }} id="connections-scripts-tab" type="button" role="tab" aria-selected={activeTab === 'scripts'} aria-controls="connections-scripts-panel" tabIndex={activeTab === 'scripts' ? 0 : -1} onKeyDown={moveTab} onClick={() => selectTab('scripts')}>脚本管理</button>
      </div>
      {activeTab === 'tools' ? <section id="connections-tools-panel" className="connections-tab-panel" role="tabpanel" aria-labelledby="connections-tools-tab"><ToolManager /></section>
        : activeTab === 'roles' ? <section id="connections-roles-panel" className="connections-tab-panel" role="tabpanel" aria-labelledby="connections-roles-tab"><RoleManager /></section>
          : <section id="connections-scripts-panel" className="connections-tab-panel" role="tabpanel" aria-labelledby="connections-scripts-tab"><ScriptManager /></section>}
    </div>
  </main>;
}
