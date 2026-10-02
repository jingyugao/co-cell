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
    try {
      await this.hooks('pre', context);
      const result = await operation();
      await this.hooks('post', context);
      return result;
    } catch (error) {
      for (const extension of this.extensions) {
        try { await extension.error?.(this.snapshot(context), error); } catch { /* Preserve the operation's failure. */ }
      }
      throw error;
    }
  }

  private async hooks(phase: 'pre' | 'post', context: SandboxLifecycleContext) {
    for (const extension of this.extensions) {
      try { await extension[phase]?.(this.snapshot(context)); }
      catch (error) { throw new SandboxExtensionError(extension.name, phase, error); }
    }
  }

  private snapshot(context: SandboxLifecycleContext): Readonly<SandboxLifecycleContext> {
    return { ...context,
      ...(context.record ? { record: structuredClone(context.record) } : {}),
      ...(context.metadata ? { metadata: { ...context.metadata } } : {}),
    };
  }
}
