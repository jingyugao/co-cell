export type KnowledgeTreeNode =
  | { kind: 'folder'; id: string; name: string; children: KnowledgeTreeNode[] }
  | { kind: 'page'; id: string; name: string };

export interface KnowledgePagePrompt {
  text: string;
  version: string;
}

export interface KnowledgePage {
  id: string;
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

export interface KnowledgeView {
  configured: boolean;
  /** Read-only deployment setting for agent Stop hooks. */
  settings: { readonly enabled: boolean };
  /** The bank's directory in Hindsight order. Only the selected page includes its body. */
  pages: KnowledgeTreeNode[];
  selectedPage?: KnowledgePage;
  bankId?: string;
  error?: string;
}
