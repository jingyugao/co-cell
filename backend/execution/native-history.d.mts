import type { Turn, CompactionContent, CompactionSelector } from '../../protocol/types.js';
export function parseNativeHistory(source: string, includeBlocks?: boolean): Turn[];
export function parseNativeCompaction(source: string, selector: CompactionSelector): CompactionContent | undefined;
export interface NativeHistory { turns: Turn[]; path?: string; nextCursor?: string | null; compaction?: CompactionContent }
export function readNativeHistory(threadId: string | null, codexHome?: string, includeBlocks?: boolean, startedAt?: string, path?: string, compactionSelector?: CompactionSelector): Promise<NativeHistory>;
export function readSubagentConversations(threadId: string, codexHome: string): Promise<import('../../protocol/types.js').SubagentConversation[]>;
