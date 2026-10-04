import type { SecretFileBundle, SecretFileIdentity, SecretTextFile } from '../protocol/secret-types.js';
export const FILE_BUNDLE_LIMIT: number;
export function validateFileBundle(input: unknown): SecretFileBundle;
export function openMeegleBundle(input: SecretFileBundle): Record<string, unknown>;
export function rebindMeegleBundle(input: SecretFileBundle, identity: SecretFileIdentity): SecretFileBundle;

export function fileBytes(file: SecretTextFile): Buffer;
export function encodeFile(path: string, bytes: Buffer, encoding?: 'base64'): SecretTextFile;
export function collectCredentialDirectory(root: string, directory: string, primaryPath: string, readCredential: (root: string, path: string, limit?: number, allowEmpty?: boolean) => Promise<Buffer>, previous?: SecretTextFile[]): Promise<SecretTextFile[]>;
