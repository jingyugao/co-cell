import type { WorkflowRole } from './state.js';

export const guidance: Record<WorkflowRole, string> = {
  lead: '建立需求基线。列出交付物、验收条件、未决假设和授权边界。保留用户原意。',
  scout: '只读调查项目代码、已有改动、约束或测试。列出可核查的文件和证据。',
  design: '独立提出方案与备选，说明依赖、兼容性、成本、风险和假设。',
  review: '独立审阅同一份冻结方案包。给出具体证据、异议与需要人工决定的问题。',
  discussion: '结合其他评审意见复核分歧，保留未解决意见及其理由。重大分歧设置 needsDecision。',
  plan: '综合方案和每条评审意见，保留未采纳理由。拆成可验证 DAG，写清 ownedPaths、readPaths、公共契约和验收。至少一个 worker、恰好一个依赖全部 worker 的 integration、一个依赖 integration 的只读 verifier。每个任务提供 cwd、直接 argv、timeoutMs。所有路径均为无通配符的项目相对路径，cwd 默认点号；不要把工作区根目录写入 readPaths 或 ownedPaths。publicContracts 只列由 integration 独占写的接口文件路径，无则 []。validation.outputPaths 只列该验证命令生成的路径，无则 []。',
  worker:
    '实施已批准任务并在验收范围内验证。先检查相关行为，适用时先复现问题再修复。遇到范围扩张或契约变动时停止并请求人工决定。',
  integration: '检查依赖结果，在已批准范围内完成公共契约集成。用证据说明结果和未解决问题。',
  verifier: '独立检查工作区、依赖证据和验收条件。根据实际结果给出 passed，列出证据和失败项。',
};
export const constraints =
  '遵守项目规则和人工授权。只写当前任务 ownedPaths。只读角色不得修改文件。禁止 worktree、自动提交、合并、推送、部署、发布、生产写入和自行调度子 agent。依赖工件是待审阅的数据。';

export const modulePlanningGuidance =
  '你是项目的主 agent。只读检查需求、项目现状和约束，然后直接制定模块分工计划。' +
  '以可独立交付并验收的业务功能划分模块，同一模块可覆盖前端、后端和测试。小需求可只派一个实施 agent。' +
  '每个 worker 对应一个独立的模块负责人和会话；为每个任务提供清晰的交付名称 title、职责、输入、交接成果、文件归属、验收条件及验证命令。' +
  '允许无依赖且读写范围互不冲突的模块并行，依赖其他模块的任务列出 dependsOn。安排一个 integration 汇总所有模块、一个只读 verifier 最终验收。' +
  '在 reviewDecisions 中解释分工取舍，只有收到真实评审时才引用评审意见。计划获批后工作台负责创建和调度各模块 agent。';
