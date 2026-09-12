import type { ProjectSummary } from '../../../shared/types';

export function requirementPrompt(project: Pick<ProjectSummary, 'name' | 'requirementUrl'> | null): string {
  if (!project?.requirementUrl) return '';
  return `请阅读飞书需求「${project.name}」并产出技术方案：
${project.requirementUrl}

使用 Meegle 工具读取完整需求内容，按需阅读关联文档、附件和评论。结合共享知识库 ~/.codex/docs/project-overview.md（项目介绍）、~/.codex/docs/key-modules.md（重点模块）以及相关仓库的实际代码，确认业务背景和现有实现。

技术方案需说明目标与范围、涉及仓库和业务模块、关键流程与改动、接口和数据设计、兼容性与风险、验证方法，以及需要进一步确认的问题。结论注明需求或代码依据；无法读取或尚未确认的内容明确说明，不要猜测。先输出方案，暂不修改业务代码或执行部署。`;
}
