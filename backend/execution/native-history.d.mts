import type { Turn } from '../../protocol/types.js';
export function parseNativeHistory(source: string, includeBlocks?: boolean): Turn[];
export interface NativeHistory { turns: Turn[]; path?: string; nextCursor?: string | null }
export function readNativeHistory(threadId: string | null, codexHome?: string, includeBlocks?: boolean, startedAt?: string, path?: string): Promise<NativeHistory>;
export function readSubagentConversations(threadId: string, codexHome: string): Promise<import('../../protocol/types.js').SubagentConversation[]>;
