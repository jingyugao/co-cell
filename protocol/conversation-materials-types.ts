export interface ConversationMaterialFile {
  threadId?: string;
  path: string;
  agentName: string;
  contextIndex: number;
  byteLength: number;
  sha256: string;
}

/** Immutable cleaned content; only metadata is stored in the database. */
export interface ConversationMaterials {
  id: string;
  sourceKey: string;
  sessionId: string;
  threadId: string;
  sourceUpdatedAt: string;
  version: number;
  complete: boolean;
  firstMessage: string;
  files: ConversationMaterialFile[];
  encryptedCount: number;
  indexByteLength: number;
  indexSha256: string;
  createdAt: string;
}
