import type { Project } from '../../protocol/types.js';

export type FollowupProject = Pick<Project, 'id' | 'name' | 'workingDirectory' | 'requirementUrl'>;
export const PROJECT_FOLLOWUP_FILE = 'PROJECT_STATUS.md';

const line = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

export function projectFollowupDocument(project: FollowupProject): string {
  return `# 项目跟进

- 项目：${line(project.name)}
- CoCell 项目 ID：${line(project.id)}
- 飞书需求：${project.requirementUrl ? line(project.requirementUrl) : '未关联'}
- 飞书 project_key / work_item_id：${project.requirementUrl ? '待从需求链接核实' : '未关联'}

## 当前进展

- 当前阶段：待整理
- 下一步：待整理
- 阻塞项：待核实

## 关联 MR

- 待整理；每项仅记录仓库、MR 链接、简短状态及必要的依赖关系。

## 文档索引

- 技术方案：待补充引用
- 验证记录：待补充引用
- 上线与回滚方案：待补充引用

更新时间：待首次跟进
`;
}

// Publish a complete file with an exclusive hard link, so concurrent API
// instances cannot truncate each other's initialization or an existing document.
export const INITIALIZE_PROJECT_FOLLOWUP = `
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const [path, content] = process.argv.slice(1);
if (!fs.existsSync(path)) {
  const staging = path + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(staging, content, { flag: 'wx', mode: 0o644 });
    try { fs.linkSync(staging, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { try { fs.unlinkSync(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
`;
