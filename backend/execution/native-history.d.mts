import type { Turn } from '../../shared/types.js';
export function parseNativeHistory(source: string, includeBlocks?: boolean): Turn[];
export interface NativeHistory { turns: Turn[]; path?: string }
export function readNativeHistory(threadId: string | null, codexHome?: string, includeBlocks?: boolean, startedAt?: string, path?: string): Promise<NativeHistory>;
