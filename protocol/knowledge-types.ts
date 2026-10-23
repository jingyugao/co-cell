export type KnowledgeCategory = 'business' | 'repositories' | 'components' | 'workflows';
export type KnowledgePrompts = Record<KnowledgeCategory, string>;

export interface KnowledgeSettings {
  revision: number;
  enabled: boolean;
  prompts: KnowledgePrompts;
}

export interface KnowledgeSettingsInput extends KnowledgeSettings {}

export interface KnowledgePage {
  category: KnowledgeCategory;
  name: string;
  status: 'pending' | 'ready' | 'failed';
  body: string;
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
