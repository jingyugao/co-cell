export type SandboxErrorCode =
  | 'busy'
  | 'closed'
  | 'conflict'
  | 'invalid'
  | 'not_tracked'
  | 'not_accessible'
  | 'unavailable'
  | 'persistence_failed';

export class SandboxManagerError extends Error {
  constructor(
    public readonly code: SandboxErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SandboxManagerError';
  }
}

export class SandboxBusyError extends SandboxManagerError {
  constructor(resourceKey: string, usageIds: string[]) {
    super('busy', `Sandbox resource ${resourceKey} is in use by: ${usageIds.join(', ')}`);
    this.name = 'SandboxBusyError';
  }
}

export class SandboxPersistenceError extends SandboxManagerError {
  constructor(resourceKey: string, cause: unknown) {
    super('persistence_failed', `Failed to persist sandbox resource ${resourceKey}`, { cause });
    this.name = 'SandboxPersistenceError';
  }
}
