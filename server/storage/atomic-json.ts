import { rename, writeFile } from 'node:fs/promises';

/** Serializes atomic writes per record while allowing unrelated records to save concurrently. */
export class AtomicJsonWriter {
  private pending = new Map<string, Promise<void>>();

  write(key: string, file: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    const operation = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, serialized, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    this.pending.set(key, operation);
    return operation;
  }

  async wait(key: string): Promise<void> { await this.pending.get(key); }
  forget(key: string): void { this.pending.delete(key); }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values()]); }
}
