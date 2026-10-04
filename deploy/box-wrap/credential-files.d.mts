import type { SecretFileBundle, SecretFileIdentity } from '../../protocol/secret-types.js';
export const FILE_BUNDLE_LIMIT: number;
export function validateFileBundle(input: unknown): SecretFileBundle;
export function openMeegleBundle(input: SecretFileBundle): Record<string, unknown>;
export function rebindMeegleBundle(input: SecretFileBundle, identity: SecretFileIdentity): SecretFileBundle;
