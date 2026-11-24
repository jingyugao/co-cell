export type KnowledgeCategory = 'business' | 'repositories' | 'components' | 'workflows';

export interface KnowledgeSettings {
  revision: number;
  enabled: boolean;
}

export interface KnowledgePagePrompt {
  text: string;
  version: string;
}

export interface KnowledgePage {
  category: KnowledgeCategory;
  name: string;
  status: 'pending' | 'ready' | 'failed';
  body: string;
  /** Present only after successfully reading this page's source query from Hindsight. */
  prompt?: KnowledgePagePrompt;
  updatedAt?: string;
  isStale: boolean;
  sourceCount: number;
  error?: string;
}

export interface KnowledgeJob {
  id: string;
  memoryId: string;
  projectName: string;
  sessionId: string;
  sessionTitle: string;
  sourceUpdatedAt: string;
  status: 'queued' | 'syncing' | 'succeeded' | 'failed';
  documentCount: number;
  error?: string;
  updatedAt: string;
}

export interface KnowledgeView {
  configured: boolean;
  settings: KnowledgeSettings;
  pages: KnowledgePage[];
  jobs: KnowledgeJob[];
  error?: string;
}
