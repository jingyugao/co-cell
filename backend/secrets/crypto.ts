import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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
}
