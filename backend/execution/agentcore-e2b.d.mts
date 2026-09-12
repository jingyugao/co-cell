import type { Sandbox } from 'e2b';
import { AgentClient } from '@swarm-hive/agentcore/client';
export interface RuntimeConnectionOptions { token: string; port?: number; endpoint?: string }
export interface RuntimeDeployOptions {
  port?: number; endpoint?: string; token?: string; directory?: string;
  sourceDirectory?: string; codexPath?: string; codexVersion?: string;
  nodePath?: string; cwd?: string; env?: Record<string, string>; readyTimeoutMs?: number;
}
export function connectAgentRuntime(sandbox: Sandbox, options: RuntimeConnectionOptions): AgentClient;
export function deployAgentRuntime(sandbox: Sandbox, options?: RuntimeDeployOptions): Promise<{
  directory: string; port: number; endpoint: string; token: string; client: AgentClient;
}>;
