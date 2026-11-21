export interface DynamicToolExecutionConfig {
  executable: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

export const MAX_TOOL_TIMEOUT_MS: number;

/** Validate the runtime execution config before it reaches spawn(). */
export function validateDynamicToolExecution(value: unknown, options?: { credentialAvailable?: boolean }): DynamicToolExecutionConfig;
