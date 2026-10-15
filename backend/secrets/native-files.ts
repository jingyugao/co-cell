import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { credentialPath } from './policy.js';
import { SecretCrypto } from './crypto.js';
import type { StoredSecret } from './repository.js';
import { fileBytes, validateFileBundle } from '../../util/credential-files.mjs';

const prefix = 'native:v1:';
type Descriptor = { kind: StoredSecret['format']; files: Array<{ path: string; encoding?: 'base64' }>;
  supportVersion?: number; homeProjectId?: string; directory?: string; adapter?: 'meegle'; identity?: { hostname: string; username: string } };

/** Only native CLI files persist. Encryption here is transient compatibility
 * with the service's in-memory interface and reading pre-migration records. */
export class NativeSecretFiles {
  private root: string;
  constructor(root: string, private crypto: SecretCrypto) { this.root = resolve(root); }
  private async directory(path: string, create: boolean) {
    let current = parse(path).root;
    for (const part of path.slice(current.length).split('/').filter(Boolean)) {
      current = join(current, part);
      if (create) {
        try {
          await mkdir(current, { mode: 0o700 });
          const parent = await open(dirname(current), 'r');
          try { await parent.sync(); } finally { await parent.close(); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
    }
  }
  async init() { await this.directory(this.root, true); await chmod(this.root, 0o700); }
  private path(id: string, relative: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid credential identity');
    return join(this.root, id, credentialPath(relative));
  }
  private async bytes(path: string): Promise<Buffer> {
    await this.directory(dirname(path), false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Invalid native credential file');
      const bytes = Buffer.alloc(info.size + 1); let count = 0;
      while (count < bytes.length) {
        const read = await handle.read(bytes, count, bytes.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      if (count !== info.size) throw new Error('Native credential changed during read');
      return bytes.subarray(0, count);
    } finally { await handle.close(); }
  }
  private async write(path: string, bytes: Buffer) {
    await this.directory(dirname(path), true);
    await chmod(dirname(path), 0o700);
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe native credential file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      const dir = await open(dirname(path), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  isNative(value: string) { return value.startsWith(prefix); }
  private descriptor(secret: StoredSecret): Descriptor {
    const value = JSON.parse(secret.ciphertext.slice(prefix.length)) as Descriptor;
    if (value.kind !== secret.format || !Array.isArray(value.files) || value.files.length > 128) throw new Error('Invalid native credential registration');
    for (const file of value.files) this.path(secret.id, file.path);
    if (secret.format === 'home') {
      if (value.files.length || !/^[a-f0-9-]{36}$/.test(value.homeProjectId ?? '')) throw new Error('Invalid HOME registration');
    } else if (!secret.path || value.files[0]?.path !== secret.path || new Set(value.files.map(file => file.path)).size !== value.files.length) {
      throw new Error('Native credential path does not match registration');
    }
    return value;
  }
  async read(secret: StoredSecret) {
    if (!this.isNative(secret.ciphertext)) return secret.ciphertext;
    const descriptor = this.descriptor(secret);
    const files = await Promise.all(descriptor.files.map(async file => ({ ...file, bytes: await this.bytes(this.path(secret.id, file.path)) })));
    let payload: string;
    if (secret.format === 'home') payload = JSON.stringify({ homeProjectId: descriptor.homeProjectId });
    else if (secret.format === 'lark') payload = JSON.stringify({ content: files[0].bytes.toString('utf8'),
      supportFiles: files.slice(1).map(file => ({ path: file.path, content: file.bytes.toString('base64'), encoding: 'base64' })), supportVersion: descriptor.supportVersion });
    else if (secret.format === 'files') payload = JSON.stringify({ ...descriptor, kind: undefined,
      files: files.map(({ path, encoding, bytes }) => ({ path, content: bytes.toString(encoding ?? 'utf8'), ...(encoding ? { encoding } : {}) })) });
    else payload = files[0].bytes.toString('utf8');
    return this.crypto.seal(secret.id, secret.currentVersionId, Buffer.from(payload));
  }
  async prepare(secret: StoredSecret, versionId: string, ciphertext: string, registered?: StoredSecret) {
    const payload = this.crypto.open(secret.id, versionId, ciphertext).toString('utf8');
    const descriptor: Descriptor = { kind: secret.format, files: [] };
    let files: Array<{ path: string; bytes: Buffer; encoding?: 'base64' }> = [];
    if (secret.format === 'home') descriptor.homeProjectId = JSON.parse(payload).homeProjectId;
    else {
      if (!secret.path || !secret.tool) throw new Error('Legacy credentials need a native tool and path before migration');
      if (secret.format === 'text') files = [{ path: secret.path, bytes: Buffer.from(payload) }];
      else if (secret.format === 'lark') {
        const value = JSON.parse(payload);
        descriptor.supportVersion = value.supportVersion;
        files = [{ path: secret.path, bytes: Buffer.from(value.content) }, ...value.supportFiles.map((file: { path: string; content: string; encoding: 'base64' }) => ({ path: file.path, bytes: fileBytes(file) }))];
      } else if (secret.format === 'files') {
        const value = validateFileBundle(JSON.parse(payload));
        Object.assign(descriptor, { directory: value.directory, adapter: value.adapter, identity: value.identity });
        files = value.files.map(file => ({ path: file.path, bytes: fileBytes(file), ...(file.encoding ? { encoding: file.encoding } : {}) }));
      } else throw new Error('Legacy credential format requires native-file reimport');
    }
    descriptor.files = files.map(({ path, encoding }) => ({ path, ...(encoding ? { encoding } : {}) }));
    const reference = prefix + JSON.stringify(descriptor);
    this.descriptor({ ...secret, ciphertext: reference });
    const previous: Array<{ path: string; before: Buffer | null; after: Buffer | null }> = [];
    const rollback = async () => {
      const failures: unknown[] = [];
      for (const item of [...previous].reverse()) {
        try {
          // Preserve any native CLI/operator change made since our write.
          let current: Buffer | null = null;
          try { current = await this.bytes(item.path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (item.after ? !current?.equals(item.after) : current !== null) continue;
          if (item.before) await this.write(item.path, item.before); else if (current) await unlink(item.path);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Native credential rollback failed');
    };
    try {
      // Publish companions before primary configs that reference them.
      for (const file of [...files.slice(1), ...files.slice(0, 1)]) {
        const path = this.path(secret.id, file.path);
        let before: Buffer | null = null;
        try { before = await this.bytes(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (before?.equals(file.bytes)) continue;
        previous.push({ path, before, after: file.bytes });
        await this.write(path, file.bytes);
      }
      if (registered && this.isNative(registered.ciphertext)) {
        for (const old of this.descriptor(registered).files) {
          if (descriptor.files.some(file => file.path === old.path)) continue;
          const path = this.path(secret.id, old.path);
          let before: Buffer;
          try { before = await this.bytes(path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          previous.push({ path, before, after: null });
          await unlink(path);
        }
      }
    } catch (error) {
      try { await rollback(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Native credential update and rollback failed'); }
      throw error;
    }
    return { reference, rollback };
  }
}
