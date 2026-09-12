import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { SandboxArchive } from '../../protocol/sandbox-types.js';

export type StoredArchive = SandboxArchive;

/** Stores already compressed archives; implementations can upload them to OSS. */
export interface SandboxArchiveStorage {
  put(source: string | Readable): Promise<StoredArchive>;
  /** Downloads and verifies the archive before atomically replacing destination. */
  get(archive: StoredArchive, destination: string): Promise<void>;
  delete(archive: StoredArchive): Promise<void>;
}

const ARCHIVE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar\.gz$/;

async function readLocalFile(path: string): Promise<Readable> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('归档必须是普通文件');
    return file.createReadStream();
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** No archive bytes are buffered in memory. Both upload and download use 0600 files. */
export class LocalSandboxArchiveStorage implements SandboxArchiveStorage {
  private directory: string;

  constructor(directory: string | URL) {
    this.directory = resolve(typeof directory === 'string' ? directory : fileURLToPath(directory));
  }

  private async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('归档存储目录无效');
    await chmod(this.directory, 0o700);
  }

  private path(archive: StoredArchive) {
    if (!ARCHIVE_KEY.test(archive.key)
      || !Number.isSafeInteger(archive.sizeBytes) || archive.sizeBytes < 0
      || !/^[0-9a-f]{64}$/.test(archive.sha256)) throw new Error('归档元数据无效');
    return join(this.directory, archive.key);
  }

  private async copy(source: Readable, destination: string, expected?: StoredArchive) {
    const temporary = join(dirname(destination), `.archive-${randomUUID()}.partial`);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    try {
      await pipeline(source, new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      const file = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      const sha256 = hash.digest('hex');
      if (expected && (sizeBytes !== expected.sizeBytes || sha256 !== expected.sha256)) {
        throw new Error('归档校验失败：文件大小或 SHA256 不匹配');
      }
      await rename(temporary, destination);
      return { sizeBytes, sha256 };
    } finally {
      source.destroy();
      await rm(temporary, { force: true });
    }
  }

  async put(source: string | Readable): Promise<StoredArchive> {
    await this.prepare();
    const key = `${randomUUID()}.tar.gz`;
    const result = await this.copy(typeof source === 'string' ? await readLocalFile(source) : source, join(this.directory, key));
    return { key, ...result, createdAt: new Date().toISOString() };
  }

  async get(archive: StoredArchive, destination: string): Promise<void> {
    const source = this.path(archive);
    await this.prepare();
    await this.copy(await readLocalFile(source), resolve(destination), archive);
  }

  async delete(archive: StoredArchive): Promise<void> {
    const path = this.path(archive);
    await this.prepare();
    await rm(path, { force: true });
  }
}
