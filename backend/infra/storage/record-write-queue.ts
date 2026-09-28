/** Serializes metadata writes per record while allowing unrelated records to save concurrently. */
export class RecordWriteQueue {
  private pending = new Map<string, Promise<void>>();

  run(key: string, action: () => Promise<void>): Promise<void> {
    const operation = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(key, operation);
    return operation;
  }

  async wait(key: string): Promise<void> { await this.pending.get(key); }
  forget(key: string): void { this.pending.delete(key); }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values()]); }
}
