import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class SecretCrypto {
  private key: Buffer;
  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== encodedKey)
      throw new Error('COCELL_SECRET_MASTER_KEY must be a base64-encoded 32-byte key');
  }
  seal(id: string, version: string, bytes: Buffer): string {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${id}\0${version}`));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  open(id: string, version: string, sealed: string): Buffer {
    try {
      const bytes = Buffer.from(sealed, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(`${id}\0${version}`)); cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    } catch { throw new Error('Secret decryption failed'); }
  }
  runtimeToken(boxId: string, generation: number): string {
    const payload = Buffer.from(JSON.stringify({ boxId, generation })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }
  verifyRuntimeToken(token: string): { boxId: string; generation: number } | null {
    const parts = token.split('.');
    if (parts.length !== 2 || token.length > 1024) return null;
    const signature = Buffer.from(parts[1]); const expected = Buffer.from(this.sign(parts[0]));
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      return typeof data.boxId === 'string' && Number.isSafeInteger(data.generation) && data.generation >= 0 ? data : null;
    } catch { return null; }
  }
  private sign(payload: string) { return createHmac('sha256', this.key).update(`cocell-tool-runtime-v1\0${payload}`).digest('base64url'); }
}
