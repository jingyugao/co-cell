import type { SandboxExtension, SandboxLifecycleContext } from './types.js';

export class SandboxExtensionError extends Error {
  constructor(readonly extension: string, readonly phase: 'pre' | 'post', cause: unknown) {
    super(`Sandbox extension ${extension} ${phase} failed`, { cause });
    this.name = 'SandboxExtensionError';
  }
}

/** Shared by the manager and provider-specific restore/activation workflows. */
export class SandboxLifecycle {
  private readonly extensions: readonly SandboxExtension[];
  constructor(extensions: readonly SandboxExtension[] = []) {
    if (extensions.some(extension => !extension.name.trim()) || new Set(extensions.map(extension => extension.name)).size !== extensions.length)
      throw new Error('Sandbox extensions must have unique, nonempty names');
    this.extensions = [...extensions];
  }

  async run<T>(context: SandboxLifecycleContext, operation: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      for (const extension of this.extensions) {
        this.assertNotAborted(context.signal);
        try {
          if (!extension.pre) continue;
          const release = await extension.pre(this.snapshot(context));
          if (release) releases.push(release);
        } catch (error) { throw new SandboxExtensionError(extension.name, 'pre', error); }
        this.assertNotAborted(context.signal);
      }
      this.assertNotAborted(context.signal);
      const result = await operation();
      this.assertNotAborted(context.signal);
      await this.hooks('post', context);
      return result;
    } catch (error) {
      for (const extension of context.signal?.aborted ? [] : this.extensions) {
        if (!extension.error) continue;
        try {
          await Promise.resolve(extension.error(this.snapshot(context), error));
        } catch { /* Preserve the operation's failure. */ }
      }
      throw error;
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async hooks(phase: 'post', context: SandboxLifecycleContext) {
    for (const extension of this.extensions) {
      this.assertNotAborted(context.signal);
      if (!extension[phase]) continue;
      try {
        await Promise.resolve(extension[phase]!(this.snapshot(context)));
      }
      catch (error) { throw new SandboxExtensionError(extension.name, phase, error); }
      this.assertNotAborted(context.signal);
    }
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  private snapshot(context: SandboxLifecycleContext): Readonly<SandboxLifecycleContext> {
    return { ...context,
      ...(context.record ? { record: structuredClone(context.record) } : {}),
      ...(context.metadata ? { metadata: { ...context.metadata } } : {}),
    };
  }
}
