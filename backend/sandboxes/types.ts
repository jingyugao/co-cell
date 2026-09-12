import type { SandboxState } from '../../protocol/sandbox-types.js';

/** Enough context to address a workspace without fabricating a conversation. */
export interface WorkspaceTarget {
  id: string;
  projectId?: string;
  settings: { workingDirectory: string };
  sandbox?: SandboxState;
  updatedAt: string;
}
export type ThreadWorkspace = WorkspaceTarget & { threadId: string | null; startedAt?: string; nativeHistoryPath?: string };
