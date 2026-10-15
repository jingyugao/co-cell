import type { Project, ProjectSummary } from '../../protocol/types.js';
import { HttpError } from '../../util/errors.js';
import { toolName } from '../secrets/policy.js';

export interface ToolResult { stdout: string; stderr: string; exitCode: number; truncated?: boolean }
export type SystemToolCommand = (tool: string, args: string[]) => Promise<ToolResult>;

/** Backend CLI work runs in the operator-created system project's credential environment. */
export class SystemTools {
  constructor(private options: {
    projects: () => Promise<Project[]>;
    enter: (id: string) => Promise<ProjectSummary>;
    acquireUsage: (boxId: string) => Promise<() => Promise<void>>;
    execute: (boxId: string, tool: string, args: string[]) => Promise<ToolResult>;
  }) {}
  async withTools<T>(action: (run: SystemToolCommand) => Promise<T>): Promise<T> {
    const matches = (await this.options.projects()).filter(project => project.name === 'system' && project.status === 'active');
    if (matches.length !== 1) throw new HttpError(409, '请保留一个使用中的 system 项目，并绑定 Sandbox');
    const project = await this.options.enter(matches[0].id);
    if (!project.sandbox || project.sandbox.status !== 'ready') throw new HttpError(503, 'system 项目的 Sandbox 尚未就绪');
    const boxId = project.sandbox.id;
    const release = await this.options.acquireUsage(boxId);
    try {
      return await action((tool, args) => {
        toolName(tool);
        return this.options.execute(boxId, `cocell_${tool.replaceAll('-', '_')}`, args);
      });
    } finally { await release(); }
  }
}
