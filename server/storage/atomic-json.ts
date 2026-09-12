import { rename, writeFile } from 'node:fs/promises';

/** Serializes atomic writes per record while allowing unrelated records to save concurrently. */
export class AtomicJsonWriter {
  private pending = new Map<string, Promise<void>>();

  write(key: string, file: string, value: unknown): Promise<void> {
    return this.run(key, async () => {
      const serialized = JSON.stringify(value);
      await writeFile(`${file}.tmp`, serialized, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
  }
  run(key: string, action: () => Promise<void>): Promise<void> {
    const operation = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(key, operation);
    return operation;
  }

  async wait(key: string): Promise<void> { await this.pending.get(key); }
  forget(key: string): void { this.pending.delete(key); }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values()]); }
}
