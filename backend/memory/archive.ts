import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const MAX_ARCHIVE_BYTES = 16 * 1024 ** 3;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_RECORD_BYTES = 16 * 1024 ** 2;
const MAX_DEPTH = 64;

class ArchiveReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private chunk = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(stream: NodeJS.ReadableStream) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async readSome(maxBytes: number): Promise<Buffer> {
    while (this.offset === this.chunk.length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        this.chunk = Buffer.alloc(0);
        this.offset = 0;
        break;
      }
      this.chunk = Buffer.from(next.value);
      this.offset = 0;
    }
    if (this.ended) return Buffer.alloc(0);
    const end = Math.min(this.chunk.length, this.offset + maxBytes);
    const result = this.chunk.subarray(this.offset, end);
    this.offset = end;
    return result;
  }

  async exact(size: number): Promise<Buffer> {
    const result = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const chunk = await this.readSome(size - offset);
      if (!chunk.length) throw new Error('Memory export archive ended unexpectedly');
      chunk.copy(result, offset);
      offset += chunk.length;
    }
    return result;
  }

  async skip(size: number): Promise<void> {
    while (size > 0) {
      const chunk = await this.readSome(Math.min(size, 1024 * 1024));
      if (!chunk.length) throw new Error('Memory export archive ended unexpectedly');
      size -= chunk.length;
    }
  }
}

function tarString(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start);
  return header.toString('utf8', start, end >= start && end < start + length ? end : start + length);
}

function tarNumber(header: Buffer, start: number, length: number): number {
  const value = header.toString('ascii', start, start + length).replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('Memory export contains an unsupported tar size');
  const parsed = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Memory export contains an invalid tar size');
  return parsed;
}

function paxRecords(bytes: Buffer): Record<string, string> {
  if (bytes.length > 64 * 1024) throw new Error('Memory export PAX header exceeds 64 KiB');
  const result: Record<string, string> = {};
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error('Memory export has a malformed PAX header');
    const lengthText = bytes.toString('ascii', offset, space);
    if (!/^\d+$/.test(lengthText)) throw new Error('Memory export has a malformed PAX record length');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10)
      throw new Error('Memory export has an invalid PAX record length');
    const record = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf('=');
    if (equals < 1) throw new Error('Memory export has a malformed PAX key/value');
    const key = record.slice(0, equals), value = record.slice(equals + 1);
    if (key === 'path') {
      if (Buffer.byteLength(value) > 4096) throw new Error('Memory export PAX path exceeds 4096 bytes');
      result.path = value;
    } else if (key === 'size') {
      if (!/^\d+$/.test(value)) throw new Error('Memory export has an invalid PAX size');
      const size = Number(value);
      if (!Number.isSafeInteger(size) || size > MAX_ARCHIVE_BYTES) throw new Error('Memory export PAX size exceeds the archive limit');
      result.size = String(size);
    } else if (key === 'linkpath' || key.startsWith('GNU.sparse.')) {
      throw new Error('Memory export contains a link or sparse PAX entry');
    }
    offset += length;
  }
  return result;
}

function safeArchivePath(value: string): string {
  const name = value.replace(/\/$/, '');
  if (!name || name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name) ||
    name.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('Memory export contains an unsafe archive path');
  if (name.split('/').length > MAX_DEPTH) throw new Error('Memory export archive nesting is too deep');
  return name;
}

function isWantedFile(name: string): boolean {
  if (/^state[^/]*\.sqlite(?:-(?:wal|shm))?$/.test(name) || /^thread_history[^/]*\.sqlite(?:-(?:wal|shm))?$/.test(name)) return true;
  return /^(?:sessions|archived_sessions)\/(?:[^/]+\/){0,4}rollout-.*-[a-f\d-]{36}\.jsonl$/i.test(name);
}

async function writeChunk(stream: NodeJS.WritableStream, bytes: Buffer): Promise<void> {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

export async function extractMemoryArchive(archivePath: string, destination: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const source = createReadStream(archivePath, { signal });
  const gunzip = createGunzip();
  const inputFailure: { error?: unknown } = {};
  source.on('error', error => { inputFailure.error = error; gunzip.destroy(error); });
  gunzip.on('error', error => { inputFailure.error ??= error; });
  source.pipe(gunzip);
  const reader = new ArchiveReader(gunzip);
  let entries = 0, unpacked = 0;
  const globalPax: Record<string, string> = {};
  let localPax: Record<string, string> = {};
  try {
    for (;;) {
      signal?.throwIfAborted();
      const header = await reader.exact(512);
      if (header.every(byte => byte === 0)) {
        for (;;) {
          const padding = await reader.readSome(1024 * 1024);
          if (!padding.length) break;
          signal?.throwIfAborted();
          unpacked += padding.length;
          if (unpacked > MAX_ARCHIVE_BYTES) throw new Error('Memory export exceeds the 16 GiB unpacked limit');
        }
        if (inputFailure.error) throw inputFailure.error;
        break;
      }
      if (++entries > MAX_ARCHIVE_ENTRIES) throw new Error('Memory export has too many archive entries');
      const checksum = tarNumber(header, 148, 8);
      const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (checksum !== actualChecksum) throw new Error('Memory export contains a damaged tar header');
      const base = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      const headerName = prefix ? `${prefix}/${base}` : base;
      const headerSize = tarNumber(header, 124, 12);
      const kind = header[156];
      if (kind === 120 || kind === 103) {
        if (headerSize > 64 * 1024) throw new Error('Memory export PAX header exceeds 64 KiB');
        const records = paxRecords(await reader.exact(headerSize));
        if (kind === 103) Object.assign(globalPax, records); else Object.assign(localPax, records);
        const padding = (512 - headerSize % 512) % 512;
        if (padding) await reader.skip(padding);
        continue;
      }
      const pax = { ...globalPax, ...localPax };
      const name = safeArchivePath(pax.path ?? headerName);
      const size = pax.size === undefined ? headerSize : Number(pax.size);
      localPax = {};
      unpacked += size;
      if (unpacked > MAX_ARCHIVE_BYTES) throw new Error('Memory export exceeds the 16 GiB unpacked limit');
      if (kind !== 0 && kind !== 48 && kind !== 53)
        throw new Error('Memory export contains a symbolic link or special tar entry');
      if (kind === 53 && size !== 0) throw new Error('Memory export contains an invalid directory entry');
      if (kind === 53) {
        if (isWantedFile(name)) throw new Error('Memory export directory conflicts with a data file');
      } else if (isWantedFile(name)) {
        const target = resolve(destination, ...name.split('/'));
        if (!target.startsWith(`${resolve(destination)}${sep}`)) throw new Error('Memory export path escapes its extraction directory');
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
        const writeFailure: { error?: unknown } = {};
        const completion = finished(output).catch(error => { writeFailure.error = error; });
        try {
          let remaining = size;
          while (remaining > 0) {
            signal?.throwIfAborted();
            const chunk = await reader.readSome(Math.min(remaining, 1024 * 1024));
            if (!chunk.length) throw new Error('Memory export archive ended unexpectedly');
            await writeChunk(output, chunk);
            if (writeFailure.error) throw writeFailure.error;
            remaining -= chunk.length;
          }
          output.end();
          await completion;
          if (writeFailure.error) throw writeFailure.error;
        } catch (error) {
          output.destroy();
          await completion;
          await rm(target, { force: true });
          throw error;
        }
        const padding = (512 - size % 512) % 512;
        if (padding) await reader.skip(padding);
        continue;
      }
      await reader.skip(size + (512 - size % 512) % 512);
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}

export async function listMemoryArchiveFiles(directory: string): Promise<{ databases: string[]; rollouts: string[] }> {
  const databases: string[] = [];
  const rollouts: string[] = [];
  async function walk(path: string): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const current = join(path, entry.name);
      if (entry.isDirectory()) await walk(current);
      else if (entry.isFile()) {
        if (/^(?:state|thread_history).*\.sqlite$/.test(entry.name)) databases.push(current);
        else if (/^rollout-.*-[a-f\d-]{36}\.jsonl$/i.test(entry.name)) rollouts.push(current);
      }
    }
  }
  await walk(directory);
  return { databases, rollouts };
}

export async function* readMemoryJsonl(path: string, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024, signal });
  let pieces: Buffer[] = [], length = 0;
  const emit = (line: Buffer) => {
    if (line.length > MAX_RECORD_BYTES) throw new Error(`Conversation record exceeds the ${MAX_RECORD_BYTES} byte limit`);
    if (!line.length) return undefined;
    try { return JSON.parse(line.toString('utf8')) as Record<string, unknown>; }
    catch { throw new Error(`Conversation JSONL record is malformed: ${basename(path)}`); }
  };
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const bytes = Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const end = bytes.indexOf(10, start);
      const part = bytes.subarray(start, end < 0 ? bytes.length : end);
      if (length + part.length > MAX_RECORD_BYTES) throw new Error(`Conversation record exceeds the ${MAX_RECORD_BYTES} byte limit`);
      if (part.length) { pieces.push(part); length += part.length; }
      if (end < 0) break;
      const line = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, length);
      const record = emit(line);
      if (record) yield record;
      pieces = []; length = 0; start = end + 1;
    }
  }
  if (length) {
    const record = emit(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, length));
    if (record) yield record;
  }
}
