import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import WorkspaceFilePage from './features/workspace-files/WorkspaceFileView';
import './styles.css';
import './features/chat/Markdown.css';

const fileRoute = /^\/projects\/([A-Za-z0-9_-]{1,100})\/files\/?$/.exec(window.location.pathname);
createRoot(document.getElementById('root')!).render(<React.StrictMode>{fileRoute ? <WorkspaceFilePage projectId={fileRoute[1]} /> : <App />}</React.StrictMode>);
