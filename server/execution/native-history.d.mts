import type { Turn } from '../../shared/types.js';
export function parseNativeHistory(source: string): Turn[];
export function readNativeHistory(threadId: string | null, codexHome?: string): Promise<Turn[]>;
