import type { Turn } from '../../shared/types.js';
export function parseNativeHistory(source: string, includeBlocks?: boolean): Turn[];
export function readNativeHistory(threadId: string | null, codexHome?: string, includeBlocks?: boolean): Promise<Turn[]>;
