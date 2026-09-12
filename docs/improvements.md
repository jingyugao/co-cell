# Agent 改进建议

E2B 项目中的 Codex 可以调用 `submit_improvement_proposal`，将实际工作中发现的改进机会提交给人工查看。分类是自由文本，不设枚举。页面位于 `/#improvements`，支持搜索、分类/项目筛选、分页、展开详情和跳转来源会话。

`submit_optimization` 专门用于知识库和沙箱环境，复用同一参数结构、数据库与查看页面。知识库重点是代码仓库介绍（服务职责、业务边界、跨仓库关系）和业务模块介绍（模块用途、关键流程、业务规则、上下游依赖）；建议需包含事实依据、目标文档位置和可直接收录的正文，避免只罗列入口、版本或简单命令。沙箱建议需来自实际环境阻碍，说明适合平台统一解决的原因、变更及验证方法。分类仍为自由文本，可使用“知识库/代码仓库介绍”“知识库/业务模块介绍”“沙箱环境”。

## 工具与提示词

共享 `data/AGENTS.md` 引导业务任务重点查阅 `project-overview.md`（项目与集群简介）和 `key-modules.md`（重点模块简介）。`submit_optimization` 的工具描述和参数说明优先面向这两份文件的补充与纠错，建议应包含目标文件、章节、事实依据和可收录正文。

工具通过 MCP server `swarm_improvements` 提供。参数均为必填文本：

| 参数 | 内容 | 字符上限 |
| --- | --- | --- |
| category | 自由文本分类 | 120 |
| title | 建议标题 | 200 |
| observation | 实际发现的问题和依据 | 8000 |
| proposal | 具体改进办法 | 16000 |
| expected_benefit | 预期收益 | 4000 |

项目、会话、轮次、沙箱 ID 由 Web 服务当前执行上下文附加，工具不接受这些来源字段。工具仅提交建议，不执行修改。页面支持人工变更状态，不自动执行建议。

共享 `data/AGENTS.md` 不要求本轮复盘，仅在共享文档说明中提供上述阅读与优化指引；worker 不再额外注入改进建议提示词。MCP 工具、数据库和查看页面继续保留。

专用工具的用途和提交标准放在工具描述与参数说明中，不恢复已删除的共享提示词。两种工具都只保存待处理建议，不直接更新共享知识库或基础模板；来源会话中的工具调用记录可区分实际调用的工具。

## 数据与传输

Web 服务使用 Node.js 内置 SQLite，将建议保存到 `data/improvements.sqlite`。可用 `IMPROVEMENTS_DB_PATH` 指定持久化文件；宿主机需要 Node.js 22.18+。数据库开启 WAL，使用参数化 SQL。运行时数据库及其 WAL 文件在 data 目录中，不提交 Git；在线备份应使用 SQLite 备份机制，或停止服务后再复制完整数据库文件。

传输流程：沙箱内 stdio MCP → 同轮 worker 的 loopback bridge → 现有 E2B 命令事件流 → 宿主机写数据库 → 沙箱中的单轮回执文件 → MCP 成功结果。沙箱无需访问宿主机 HTTP 地址，也不会得到数据库连接或写入身份权限。

每轮 bridge 使用独立 token 和随机回执目录。宿主机校验请求 ID，回执位置和来源身份由宿主机确定；写入完成才返回成功，失败、取消或超时会返回未确认提示。执行结束前等待已接收请求处理完成，再清理回执目录。

同一请求重传具有幂等性；同一项目内五个业务字段完全相同的建议会合并并保留首条来源，不做语义去重。项目或会话删除后建议仍保留，页面标明来源不可访问。

## 代码与接口

- `backend/improvements/store.ts`：输入校验、SQLite 数据库、去重和查询。
- `backend/improvements/routes.ts`：`GET /api/improvements` 和 `GET /api/improvements/:id`，沿用 Web 服务的本机访问限制。
- `backend/execution/worker/improvement-mcp.mjs`：工具定义与 stdio MCP 协议。
- `backend/execution/worker/improvement-bridge.mjs`：单轮桥接与等待回执。
- `backend/sandboxes/e2b.ts`：同步工具脚本、消费建议事件、返回数据库回执。
- `fe/features/improvements/`：人工查看页面。

列表支持 `q`、`category`、`projectId`、`limit`（默认 30，最多 100）及 `offset`。建议状态初始为 `pending`，页面显示“待处理”。列表另支持 `status` 筛选（不传时返回全部）；页面默认只看待处理，可切换全部状态。来源名称保存提交时的快照。

MCP 配置依据 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)；SQLite 接口参见 [Node.js 22.18 文档](https://nodejs.org/download/release/v22.18.0/docs/api/sqlite.html)。

## 人工处理状态

| 当前状态 | 可执行操作 |
| --- | --- |
| 待处理 `pending` | 暂不处理、标记完成 |
| 暂不处理 `deferred` | 恢复待处理、标记完成 |
| 已完成 `completed` | 重新打开为待处理 |

暂不处理不会删除建议，也不代表永久拒绝。标记完成只记录人工处理结果，不会触发 Agent 或自动修改知识库、沙箱。操作可填写最多 2000 字的备注，保存变更时间和处理记录；旧备注保留在历史中。

`PATCH /api/improvements/:id/status` 接收 `{ status, expectedStatus, note? }`。`expectedStatus` 防止旧页面覆盖其他人的状态变更，冲突时返回 409；相同状态重复提交不修改备注和时间。列表返回 `updatedAt` 和 `statusNote`，详情和变更响应包含 `statusHistory`。

服务启动时在事务内迁移旧的 SQLite 状态约束，保留建议正文、来源、提交幂等键和去重索引。Agent 重复提交已暂缓或已完成的建议时，回执返回已有状态，不重新打开，也不覆盖人工备注。
