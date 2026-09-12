# swarm-hive 项目说明

基于 TypeScript、Codex SDK 和 React 的单用户 Web 编码工作台。每个项目使用一个 E2B 沙箱，项目内可以创建多个独立会话。真正的 Codex CLI 在沙箱中执行模型循环、命令和文件操作；页面展示 SDK 事件、工具详情、代码差异与运行进度。

侧栏提供项目、沙箱、模板、共享文件以及连接与凭据管理。创建时填写飞书需求详情链接，会通过宿主机已登录的 Meegle 自动读取需求名称；不绑定需求时手动填写项目名。绑定需求项目的新会话顶部提供“阅读需求并产出技术方案”快捷卡片，点击后将提示词填入输入框，可编辑后发送。

## 快速启动

需要 Node.js 22.18+、pnpm 10、可用的 E2B 服务和模型 API key。当前模板构建脚本还依赖本机安装的 `~/.data/e2b/client/config.mjs`，该客户端不随仓库提供。

```sh
pnpm install --frozen-lockfile
test -f .env || cp .env.example .env
```

在 `.env` 中填写 `CODEX_API_KEY`（或 `OPENAI_API_KEY`），配置 E2B 连接；使用模型代理时设置 `OPENAI_BASE_URL`。随后启动：

```sh
PORT=3001 pnpm dev
```

打开 http://localhost:3001 。开发模式包含 Vite 中间件，无需单独启动前端。生产运行：

```sh
pnpm build
PORT=3001 pnpm start
```

创建项目，进入项目后新建会话并发送任务。首次执行时创建沙箱；同项目后续会话复用该沙箱，各自保存 Codex thread。页面不展示本机历史入口，日常工作通过 E2B 项目进行。未配置 E2B 和模型 API key 时可以启动界面，但无法创建项目开始聊天；仅执行本机 `codex login` 不足以启用这一流程。

Web 新会话默认使用 `gpt-6-astra`，输入框旁的模型下拉框支持切换到 `gpt-5.6-sol`。已有会话保留已保存的模型；服务端未指定 `CODEX_MODEL` 时同样默认 `gpt-6-astra`。

## 配置与持久目录

完整配置见 `.env.example` 和 [E2B 接入](e2b-integration.md)。常用变量：

| 变量 | 用途 |
| --- | --- |
| `PORT` | HTTP 端口，默认 `3000` |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | 模型认证，前者优先；只由服务端和沙箱使用 |
| `OPENAI_BASE_URL` | 沙箱可访问的 Responses API 地址；自定义 provider 默认使用 HTTP SSE |
| `CODEX_MODEL` | 默认模型，留空沿用执行环境配置 |
| `E2B_API_KEY` / `E2B_API_KEY_FILE` | E2B 认证，显式 key 优先 |
| `E2B_API_URL` / `E2B_SANDBOX_URL` | E2B API 与沙箱代理地址 |
| `E2B_TEMPLATE` | 模板管理首次初始化时使用的默认模板 |
| `E2B_WORKSPACE` | 项目沙箱内的默认工作目录 |
| `CODEX_WEB_DATA_DIR` | JSON 元数据及旧数据导入目录，默认 `data/web-state` |

E2B 内固定使用 `danger-full-access` 和命令网络访问；工作范围通过共享与项目 `AGENTS.md` 约定。模型、思考强度和网页搜索可按会话调整。底层本地执行的权限配置仍保留，但启用 E2B 时不能通过本机会话继续执行任务。

需要单独备份以下数据，Git 不保存它们：

| 路径 | 内容 |
| --- | --- |
| `data/web-state/` 或 `CODEX_WEB_DATA_DIR` | JSON 项目、会话元数据；配置 `MYSQL_URL` 后使用 MySQL |
| `data/images/` 或 `CODEX_WEB_IMAGES_DIR` | 上传图片 |
| `data/AGENTS.md`、`data/docs/` | 各项目沙箱共享的规则和参考文档 |
| `data/e2b/` | 模板配置、默认版本、构建记录与报告 |
| `data/credentials/` | 加密连接凭据与验证记录 |
| `~/.config/swarm-hive/credentials.key` | 凭据解密密钥，须与加密数据一并备份 |
| `data/logs/` | 有保留期限的运行诊断日志 |

`CODEX_WEB_DATA_DIR` 只改变 JSON 元数据与旧数据导入目录，不会迁移 `data/`、凭据密钥或 E2B 服务存储。沙箱工作区与 Codex 原生上下文保存在 E2B 内，不能仅靠 Web 历史恢复。

## 执行与展示边界

- 同项目多个会话可以共享工作区并行执行，各自保留独立上下文；停止一个会话不影响其他会话。关闭或刷新页面不会停止后台任务；重启 Web 服务会中断任务，需要之后继续会话。
- 删除会话只删除网页历史和附件，保留项目沙箱。删除项目会删除其全部会话并销毁沙箱。
- SDK 提供任务和 item 事件，页面按实际事件更新；它不提供逐 token 文本 delta 或交互审批接口。本应用使用 `approvalPolicy: never`。
- 工具详情中的 JSON 是 SDK item；原始工具消息另从对应 Codex rollout 读取。Git 面板反映当前整个工作区差异，不仅是本轮修改。
- 已确认的模型容量错误可以按原通道重试单次 HTTP 请求，最多四次；不会重新提交整个用户任务。详见 [模型过载重试](model-overload-retries.md)。

服务绑定 `127.0.0.1` 并校验 API Host/Origin，适用于单用户本地访问。多用户或公开部署需要另外实现身份认证和访问隔离。

## 开发与验证

```sh
pnpm typecheck
pnpm build
```

模板验证和 `pnpm capture:http` 会访问实际 E2B 或模型服务。模板构建运行 `pnpm e2b:build`，前置条件和生效方式见 [模板管理](template-management.md)。

代码按功能组织，每个后端模块的 HTTP 接口放在自身的 `routes.ts`，`backend/app.ts` 只负责公共中间件和路由装配。

| 目录 | 职责 |
| --- | --- |
| `backend/projects/` | 项目记录、归档、操作与删除保护 |
| `backend/sessions/` | 会话、历史迁移、订阅与跨模块操作协调 |
| `backend/execution/` | 单轮 Codex 执行、事件处理、原始工具消息；`worker/` 是同步到沙箱的运行脚本 |
| `backend/sandboxes/` | E2B 生命周期、端口预览、资源清单与工作区接口 |
| `backend/templates/`、`connections/`、`shared-files/` | 模板、凭据、共享文档及各自路由 |
| `backend/infra/` | 持久化、静态资源服务、运行日志及诊断等技术支撑 |
| `backend/workspaces/` | 项目工作区文件访问、下载、路径权限和 Git 查询 |
| `fe/features/` | projects、chat、sandboxes、templates、connections、shared-files 页面及局部状态 |
| `fe/components/`、`fe/lib/` | 公共组件、HTTP 请求 |
| `protocol/` | 前后端数据契约、消息与事件类型。 |
| `util/` | 事件归并、用量汇总、费用估算及模型常量，不依赖 React 或服务端存储。 |

项目记录由 ProjectService 管理，SessionManager 保留会话与沙箱之间的协调入口；执行事件的消费由 runTurn 负责。沙箱的预览、巡检和删除接收 WorkspaceTarget，无需构造空会话。前端 useProjects 管理项目数据，useSessionStream 管理当前会话的 SSE；项目编辑和归档直接应用接口返回值，不重新拉取会话列表。

本次拆分保留 API 路径、持久化格式和沙箱内运行脚本的文件名，已有项目、会话、沙箱映射无需迁移。会话中的 sandbox 兼容快照暂时保留。`backend/index.ts` 仍是服务启动入口。

## 文档索引

长期维护的项目文档集中在 `docs/`；`tmp/docs/` 仅保留临时调查、演示及协议样本。运行时共享知识库继续使用 `data/docs/`。

- [项目架构、模块职责与设计思路](AGENTS.md)
- [Agent 改进建议与数据库](improvements.md)
- [项目文件与资源链接](workspace-resources.md)
- [Kubernetes 开发调试权限](kubernetes-access.md)
- [项目与会话](projects.md)
- [E2B 接入与生命周期](e2b-integration.md)
- [本机 E2B 服务维护与重建](e2b-restore.md)
- [模板管理](template-management.md)
- [运行日志](runtime-logging.md)
- [原始 HTTP 抓包](http-capture.md)
- [模型过载重试](model-overload-retries.md)
