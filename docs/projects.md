# 项目

项目是需求、会话、工作区和 Sandbox 的组织单位。一次研发工作可以包含方案讨论、代码实现、验证和后续维护多个会话，共用同一份代码与环境。

## 项目与会话

支持普通项目、关联飞书需求的项目，以及按周归集的项目。关联需求时，由已登录的 Meegle CLI 读取需求名称与状态，技术方案入口会结合需求、共享知识和代码发起讨论。

创建项目或会话时不启动 Sandbox，首次执行任务时创建。每个会话保留独立的 Codex thread 和网页历史；同一会话一次执行一个任务，不同会话可以并行。同项目会话共享文件，修改同一文件时需要协调。

项目和会话状态由 CoCell 实例保存。设备能够访问同一实例时，同一使用者可以跨浏览器接续工作。浏览器关闭或刷新不结束已经提交的任务；服务重启后重新观察 Sandbox 已接受的活动任务。

## 生命周期

| 状态 | 用途 | 后续操作 |
| --- | --- | --- |
| 使用中 | 推进需求、开发和验证 | 继续会话、备份、标记完成或归档 |
| 已完成 | 暂时结束研发，等待回收环境 | 恢复使用；到期后自动归档 |
| 已归档 | 保留项目记录与备份，释放 Sandbox | 从最新备份恢复环境 |

已完成项目的自动归档等待时间由 `SANDBOX_ARCHIVED_RECLAIM_AFTER_MS` 控制，默认一天。归档和恢复的校验、执行顺序见[归档](archive-module.md)。

会话可以单独归档并保留历史，取消归档后继续使用。删除会话保留项目 Sandbox；删除项目会删除其会话并回收当前环境。

## 工作产物

会话中可以查看工具调用、代码差异、Token 使用和费用估算。项目文件链接支持文本、Markdown、图片预览和下载，服务链接可以打开项目内的运行预览。

文件预览使用当前工作区内容。归档后的备份文件可通过归档浏览查看；恢复项目后继续使用工作区和服务预览。

## 持久化与接口

项目元数据使用 JSON 或 MySQL 保存，由 `MYSQL_URL` 选择存储方式。JSON 默认位于 `data/web-state/`。`project.sandbox` 保存项目的当前环境绑定，会话同步该绑定。

| 接口 | 用途 |
| --- | --- |
| `GET /api/projects` | 项目列表、会话与备份摘要 |
| `POST /api/projects` | 创建项目 |
| `GET /api/projects/:id` | 项目详情 |
| `PATCH /api/projects/:id` | 更新名称、需求链接或项目状态 |
| `POST /api/projects/:id/backup` | 立即备份 |
| `POST /api/projects/:id/archive` | 备份并归档 |
| `POST /api/projects/:id/sandbox/rebuild` | 从最新备份恢复环境 |
| `GET /api/projects/:id/files` | 查看或下载项目文件 |
| `DELETE /api/projects/:id` | 删除项目 |

实现入口：[项目服务](../backend/projects/service.ts)、[项目接口](../backend/projects/routes.ts)、[会话管理](../backend/sessions/manager.ts)。
