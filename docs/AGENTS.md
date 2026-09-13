# swarm-hive 项目开发指南

本文件面向修改 swarm-hive 自身代码的 Agent。所有代码路径以仓库根目录为基准。
它与 `data/AGENTS.md` 不同：后者是平台维护的业务 Agent 共享规则，每轮任务下发到 Sandbox 沙箱。修改本文件不会改变业务 Agent 的提示词。

## 项目定位

swarm-hive 是基于 Codex TypeScript SDK 的 Web 编码工作台。用户按项目管理需求、会话和工作区；每个项目拥有一个本地 Docker Sandbox，项目中的多个会话共享文件，各自保留 Codex 上下文。

平台提供任务执行、工具过程展示、项目文件预览、Sandbox 生命周期、连接凭据、共享知识库及改进建议管理。模型循环和工具执行交给 Codex，本项目负责接入、资源管理、持久化和用户交互。

技术栈为 TypeScript、Node.js 22.18+、Hono、React、Vite、pnpm。项目与会话采用原子 JSON 文件存储，改进建议采用 SQLite。依赖版本以 `package.json` 和锁文件为准。

## 架构与运行位置

```text
用户浏览器：React 页面、会话路由、SSE 订阅、文件链接解析
    │ HTTP 请求 / SSE 事件
    ▼
宿主机：Hono Web 服务
    ├─ ProjectService：项目记录与沙箱归属
    ├─ SessionManager：会话状态、任务控制、事件订阅、跨模块协调
    ├─ runTurn：消费执行事件、更新并保存 turn、发布页面事件
    ├─ 凭据 / 共享文档 / 改进建议 / 诊断
    └─ ContainerCodexRuntime：连接沙箱、管理常驻 App Server 与生命周期
            │ Docker CLI、命令输出、文件操作
            ▼
Docker 项目 Sandbox
    ├─ 容器入口 → 常驻 Codex App Server（WebSocket JSON-RPC）→ 模型与工具循环
    ├─ 项目工作区、业务代码、开发工具、业务服务
    ├─ ~/.codex：Codex 原生上下文及共享文档副本
    └─ ~/.codex-web/credentials：只读凭据及 App Server capability token
```

当前通过 `packages/agentcore` 接入 Codex App Server：每个 Sandbox 在容器入口启动一个常驻 App Server，Web 通过受 capability token 保护的 Docker 内网 WebSocket 使用 JSON-RPC 管理多个线程和 turn，并把原生通知转换为共享事件。底层 App Server 自行推进工具调用，不要把前端订阅事件当成能够控制每个模型步骤的暂停点。

## 核心概念与归属

| 对象 | 职责与关系 |
| --- | --- |
| Project | 稳定的业务资源入口，保存名称、可选飞书需求 URL、工作目录及当前沙箱信息。 |
| Session | 属于项目，保存独立设置、消息历史和 `threadId`；不是一个独立沙箱。 |
| Turn | 一次用户提交及其执行结果，包含多个 SDK item、状态、错误和用量。 |
| Sandbox | 项目的运行环境；可暂停、恢复和删除，不能作为永久项目标识。 |
| ImprovementProposal | Agent 提交的建议，保留来源和人工处理历史；提交不等于自动执行。 |

同一会话同一时刻只运行一个 turn；同项目不同会话允许并行，文件冲突由实际协作处理，不增加项目级执行互斥。`ProjectService.acquire()` 的用途是防止资源操作与项目删除冲突，不是限制多会话并行。

项目归档后只出现在项目管理的“归档”页签。归档会删除并解绑当前容器，不保存工作区或 Codex 数据；恢复使用前要显式重建全新的空 Sandbox。项目生命周期操作保留历史。删除项目会同时删除会话和当前容器，删除单个会话仍保留项目 Sandbox。

## 模块介绍

| 模块 | 入口及职责 |
| --- | --- |
| `backend/index.ts` | 读取配置、创建服务依赖、初始化存储、启动 HTTP/Vite、处理退出。 |
| `backend/app.ts` | 公共 Host/Origin 校验、请求大小限制、错误处理和路由装配。业务接口放到各模块。 |
| `backend/projects/` | 项目创建、编辑、归档、删除保护；`requirements.ts` 读取飞书需求名称。 |
| `backend/sessions/` | `manager.ts` 管理会话、运行任务、持久化和订阅；`routes.ts` 提供会话、提交、停止、SSE 等接口。 |
| `backend/execution/` | `runner.ts` 处理单轮执行；`raw-tools.ts` 读取 Codex 原始工具记录。 |
| `packages/agentcore/` | Codex App Server 运行时适配层：通过 JSON-RPC 启动/恢复线程、执行或中断 turn，归一化 item、用量和状态事件；不负责宿主机路由或持久化。 |
| `backend/execution/worker/` | Sandbox 检查及兼容旧 worker 执行记录的辅助脚本；新 turn 不再启动单轮 worker。 |
| `backend/sandboxes/` | 管理项目绑定、Docker provider、资源清单、文件与端口访问。 |
| `backend/workspaces/` | Git 差异查询；文件路径校验、受限读取、内容类型和大小判断。 |
| `packages/sandbox/`、`packages/docker-sandbox/` | provider-neutral 生命周期协调层和 Docker 命令传输。 |
| `scripts/sandbox/` | Sandbox 命令工具安装脚本。 |
| `backend/connections/` | 本机凭据导入、加密存储、权限校验及 Sandbox 动态同步；不把密钥写入镜像或 Git。 |
| `backend/shared-files/` | 管理持久化共享规则与知识库，加载待下发的文档。 |
| `backend/improvements/` | 建议校验、去重、SQLite 迁移、查询、人工状态转换与历史。 |
| `backend/infra/` | 技术支撑：`storage/` 实现 JSON/MySQL 持久化，`http/` 提供生产静态文件，`diagnostics/` 管理日志与 HTTP 诊断。 |
| `protocol/` | 前后端数据契约、消息与事件类型。 |
| `util/` | 公共错误类、事件归并、用量汇总、费用估算及模型常量，不依赖 React 或服务端存储。 |
| `fe/App.tsx` | 页面装配、当前项目/会话选择及跨页面状态协调。 |
| `fe/features/` | 按业务划分的页面与局部逻辑；`chat` 管理消息渲染、模型设置和 SSE，`workspace-files` 管理文件预览。其余目录与业务模块对应。 |
| `fe/lib/`、`fe/components/` | HTTP 客户端、浏览器路由、资源链接解析及公共 UI 组件。 |

## 关键调用链

### 发送消息

1. 页面向 `/api/sessions/:id/turns` 提交消息，`SessionManager.startTurn()` 预留该会话的运行位置并持久化初始状态。
2. `runTurn()` 根据执行模式调用本地 SDK 或 `ContainerCodexRuntime.run()`；日常项目使用 Sandbox。
3. Sandbox runtime 获取项目沙箱，连接其常驻 App Server；共享文档和凭据通过只读挂载提供。
4. Web 使用会话 `threadId` 通过 agentcore 的 WebSocket JSON-RPC 恢复或创建线程，并订阅原生事件。
5. 宿主机归并事件，先保存会话，再通过 SSE 发布；结束时保存最终状态并释放运行记录。

浏览器断开只取消订阅，不停止任务；重连通过会话快照恢复展示。agentcore 事件、Codex rollout 原始工具消息、模型 HTTP 抓包是不同数据来源，不混用，也不根据文件变更结果臆造原始工具参数。

### 打开沙箱资源

`fe/lib/resource-links.ts` 根据消息所属项目和会话工作目录解析链接；文档中的相对路径以当前文档目录为基准。原消息不改写。外部域名保持外部链接，无法确认的本地地址不自动当作主站路由。

文件链接落到 `/projects/:id/files?path=...`，后端通过 `/api/projects/:id/files` 读取项目当前沙箱中的文件。权限以服务端项目工作区及明确允许的共享文档目录为准，并检查真实路径和已打开的文件描述符；前端分类不是权限边界。HTML/SVG 不在主页面执行。端口服务复用 `/api/projects/:id/preview`。

### 收集与处理建议

建议通过沙箱 MCP → 同轮 bridge → worker 事件 → 宿主机 SQLite → 沙箱回执文件返回。来源身份由宿主机附加，工具只能提交建议正文，收到数据库确认后才算成功。

人工状态为 `pending`（待处理）、`deferred`（暂不处理）、`completed`（已完成）。暂不处理可恢复或完成，已完成可重新打开；状态变更保留备注和历史并校验预期状态。重复工具提交返回已有建议及真实状态，不覆盖人工决定。当前没有系统 Agent 自动处理建议。

## 设计思路与开发边界

- **按能力归属拆分。** 路由负责输入输出，业务服务管理自身状态，runtime 处理 Sandbox 细节；避免继续把通用逻辑堆进 `App.tsx` 或 `SessionManager`。后两者当前仍承担协调，不应把它们描述为已完全解耦。
- **复用真实上下文。** 无需对话的文件、预览和生命周期操作使用 `WorkspaceTarget`；需要原生历史时才使用带 `threadId` 的上下文，不构造虚假会话。
- **区分持久记录和进程状态。** 项目和会话历史落盘，活动任务、连接和订阅主要在内存；存在历史不代表可以精确接续中断的工具调用。
- **资源入口绑定项目。** 对外链接依赖稳定项目 ID，由服务端解析当前沙箱；替换沙箱后尽量保持入口不变。文件预览展示当前内容，不提供历史文件快照。
- **共享资源有唯一来源。** 共享规则、知识库和凭据在宿主机维护；沙箱内下发副本不是最终来源。仅修改副本不能声称平台配置已经更新。
- **兼容已有持久化数据。** 改字段和状态时考虑旧 JSON/SQLite 迁移、去重和重启后的行为，迁移不能丢失原始来源或人工处理记录。
- **明确可观测的状态。** 准备环境、运行、重试、结束，以及 Sandbox 暂停或删除等状态按真实事件表达。错误保留原始原因并脱敏，不把连接错误一概解释为沙箱已丢失。
- **控制改动范围。** 小功能先完成直接需要的链路，避免顺手引入系统 Agent、任务队列或权限重构。分类等已约定的自由文本不要擅自改为固定枚举。

## 持久化与生命周期

| 位置 | 数据 |
| --- | --- |
| `data/web-state/` 或 `CODEX_WEB_DATA_DIR` | JSON 项目、会话元数据；配置 `MYSQL_URL` 后使用 MySQL。 |
| `data/images/` 或 `CODEX_WEB_IMAGES_DIR` | 上传图片。 |
| `data/improvements.sqlite` | 建议及状态历史，可由 `IMPROVEMENTS_DB_PATH` 调整。 |
| `data/AGENTS.md`、`data/docs/` | 共享规则与知识库；沙箱文档副本位于 `/home/user/.codex/docs`。 |
| `data/credentials/` | 加密凭据；解密密钥独立保存在宿主机配置目录。 |
| `data/logs/` | 运行日志。 |
| Sandbox 内的工作区、`~/.codex` | 业务文件和 Codex 原生上下文，Web 会话 JSON 不能代替它们。 |

长期维护的项目文档放在 `docs/`；一次性排障、实验、演示和抓包记录放在 `tmp/docs/`。运行数据不提交 Git，需要共享给业务 Agent 的知识另放持久化的 `data/docs/`。本文件正文位于 `docs/AGENTS.md`，根目录 `AGENTS.md` 是指向它的符号链接。

项目标记完成满一天后由巡检归档；显式归档立即执行。归档会删除容器并清除项目与会话上的引用。归档项目不会因文件、预览或任务请求自动重建，只能由用户点击重建；重建不恢复旧数据。


**当前重启限制：** Web 后端退出会取消活动任务，启动时把未完成任务标为中断。Sandbox 内常驻 App Server 仍存在，但旧 Web 连接不会自动接管活动 turn。无感升级与步骤检查点均未实现；更新运行服务前先确认是否有任务，不能为了发布小改动直接中断用户会话。

### Docker Compose 运行

仓库根目录的 `docker-compose.yml` 用于构建项目 Sandbox 镜像并运行生产模式 Web 服务。容器服务名为 `swarm-hive`，宿主机端口映射为 `3001`；Compose 会挂载 `data/` 和 Docker socket。本地部署持有宿主机 Docker 权限，不提供安全隔离。

常用命令通过根目录 `Makefile` 执行：

```sh
make up       # 构建镜像并后台启动
make ps       # 查看容器状态
make logs     # 跟踪服务日志
make restart  # 构建并重启
make down     # 停止并删除 Compose 容器
```

`make up` 会先在宿主机直接构建 Sandbox 镜像，再构建并启动 Compose 服务。直接使用 Compose 时，先执行 `docker build -f docker/sandbox/Dockerfile -t swarm-hive-sandbox:latest .`，再执行 `docker compose up -d --build`。服务启动后访问 `http://localhost:3001`。不要使用 `--remove-orphans` 清理其他 Compose 服务，除非已确认孤儿容器不再被使用。

## 开发入口与验证

```sh
pnpm install --frozen-lockfile
PORT=3001 pnpm dev
pnpm typecheck
pnpm build
PORT=3001 pnpm start
```

开发模式由同一个后端挂载 Vite 中间件；生产模式先构建，再启动。应用代码默认端口为 `3000`，仓库 Docker Compose 生产配置固定使用 `3001`；使用 `PORT` 时以实际配置为准。Python 辅助脚本需要环境时使用 `uv`。

修改前沿相关模块的路由、业务服务和数据契约阅读；接口变更同时更新 `protocol/` 与页面，涉及共享计算时同步更新 `util/`。按改动验证类型、构建和必要的真实行为，避免为可逆的小改动增加大量永久单元测试；临时验证脚本放 `/tmp`。凭据导入和真实模型验证会访问实际环境，不作为普通文档或 UI 修改的例行检查。

详细说明按需阅读：`docs/README.md`、`projects.md`、`workspace-resources.md`、`improvements.md`、`runtime-logging.md`、`http-capture.md`、`model-overload-retries.md`、`kubernetes-access.md`（均位于 `docs/`）。
