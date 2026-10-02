import SecretManager from './SecretManager';
import './ConnectionsPage.css';

type Props = { onMenu: () => void; onBack: () => void };
export default function ConnectionsPage({ onMenu, onBack }: Props) {
  return <main className="main-pane connections-page">
    <header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>☰</button><div className="breadcrumbs"><span>工作空间</span><span className="slash">/</span><strong>Secret 管理</strong></div><button className="secondary-button" onClick={onBack}>返回对话</button></header>
    <div className="connections-scroll"><SecretManager /></div>
  </main>;
}
