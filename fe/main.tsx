import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import WorkspaceFilePage from './features/workspace-files/WorkspaceFileView';
import { registerPwa } from './lib/pwa';
import './styles.css';
import 'katex/dist/katex.min.css';
import './features/chat/Markdown.css';

const WorkflowPage = React.lazy(() => import('./features/workflows/WorkflowPage'));
const workflowRoute = /^\/workflows(?:\/([\w-]+))?\/?$/.exec(location.pathname);
const newWorkflow = /^\/projects\/([\w-]+)\/workflows\/new\/?$/.exec(location.pathname);
const fileRoute = /^\/projects\/([A-Za-z0-9_-]{1,100})\/files\/?$/.exec(window.location.pathname);
createRoot(document.getElementById('root')!).render(<React.StrictMode>{workflowRoute || newWorkflow ? <React.Suspense fallback={<p>工作台加载中…</p>}><WorkflowPage runId={workflowRoute?.[1]} projectId={newWorkflow?.[1]}/></React.Suspense> : fileRoute ? <WorkspaceFilePage projectId={fileRoute[1]} /> : <App />}</React.StrictMode>);
registerPwa();
