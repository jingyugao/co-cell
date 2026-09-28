import type { ProjectSummary, SandboxInventory, SessionSummary } from '../../protocol/types.js';

export interface SandboxInventoryReader {
  read(sessions: SessionSummary[], projects?: ProjectSummary[]): Promise<SandboxInventory>;
  invalidate?(): Promise<void>;
}
