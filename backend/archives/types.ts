/** 归档流 — 一个逻辑实体的归档版本链 */
export interface ArchiveStream {
  archiveKey: string;
  latestVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 归档版本 — 一次归档的产物 */
export interface ArchiveVersion {
  id: string;
  archiveKey: string;
  version: number;
  parentId: string | null;
  isLatest: boolean;
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
  status: 'active' | 'soft_deleted';
  createdAt: string;
  deletedAt: string | null;
}

/** 创建归档版本的输入参数 */
export interface CreateArchiveVersionInput {
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
}

export interface ArchiveListOptions {
  status?: 'active' | 'soft_deleted';
  offset?: number;
  limit?: number;
}