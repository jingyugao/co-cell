# CoCell

**面向个人开发者的 AI 研发工作台：管理研发流程，按需恢复工作环境，跨设备接续任务，让项目经验持续积累。**

CoCell 将需求、项目、Agent 会话、代码工作区和知识库放在一起。你可以围绕一个需求持续推进方案、开发和验证，在多个任务间切换，并在下次回来时继续使用已有的环境和上下文，减少重复解释业务、准备环境和查找历史的工作。

当前定位是自托管、单用户的研发工作台，基于 TypeScript、Hono、React 和 Codex App Server 构建。

## CoCell 能做什么

### 1. 管理研发流程，减少重复工作

以项目组织任务和会话，保留需求来源、执行过程和工作产物。支持普通项目、关联飞书需求的项目，以及按周归集的项目。

- 关联飞书项目需求，读取名称和状态，从需求入口发起技术方案讨论。
- 同一项目中的多个会话复用工作区和 Sandbox，各自保留独立的对话上下文。
- 将方案讨论、代码实现、问题排查放在不同会话中，减少任务切换时反复准备环境的成本。
- 用“使用中 → 已完成 → 归档”管理项目生命周期，需要继续时恢复工作。

CoCell 提供任务组织和执行环境；研发步骤由你和 Agent 在会话中推进。

### 2. 按需使用 Sandbox，管理内存和磁盘占用

每个项目拥有自己的 Sandbox，首次执行任务时创建，后续会话继续复用。短期闲置与长期存放采用不同的处理方式：

| 场景 | 处理方式 | 收益 |
| --- | --- | --- |
| 暂时不用，稍后继续 | 通过 gVisor checkpoint 保存运行状态并暂停，需要时恢复 | 释放闲置 Sandbox 的运行内存，恢复后接续工作 |
| 项目告一段落 | 备份工作区与 Codex 状态后归档，释放原 Sandbox | 减少长期保留容器带来的磁盘占用 |
| 重新开始工作，或原环境异常 | 校验最新备份，在新 Sandbox 中恢复并验证后切换 | 复用已保存的代码和会话状态，减少从头准备的工作 |

当前使用 **gVisor** 运行 Sandbox。闲置后通过 checkpoint 将运行状态保存到磁盘并停止实例，释放运行内存；再次使用时从 checkpoint 恢复，继续已有工作。默认闲置阈值为一小时，可按使用习惯调整。

归档保存的是工作区与 `~/.codex`，恢复时使用新环境。镜像外临时安装的系统软件需要通过镜像或初始化流程重建。压缩备份本身仍占磁盘，实际节省量取决于项目内容和保留版本数。

### 3. 维护长期记忆，让经验跨任务复用

把稳定的项目背景、业务规则和开发约定沉淀为可编辑的共享知识库，减少每次开始任务都重新介绍项目的工作。

- **共享规则**：通过 `data/AGENTS.md` 维护工作约定。
- **共享知识库**：通过 `data/docs/` 维护仓库职责、业务模块、常见问题和操作经验；任务准备时同步到 Sandbox，供 Agent 查阅。
- **持续纠错**：Agent 可以提交知识库补充、纠错和环境优化建议，附上依据、目标文档和建议正文。
- **人工维护**：在页面中编辑共享文件、处理建议状态，再把确认后的经验写入知识库。

当前长期记忆以文件化知识和持久化会话为基础。建议提交后进入待处理列表，由人确认并维护知识内容。

### 4. 让长任务可以持续推进

浏览器关闭或刷新后，已提交的任务仍可继续执行；Web 服务重启后，会重新观察 Sandbox 已接受的活动任务。每个项目可以保留多个独立会话，同一项目的不同会话可并行推进。

通知中心汇集任务完成、失败、取消和待确认事项。Agent 可通过审批工具提出需要人工决定的问题，方便你在多个项目之间切换。同项目会话共享文件，修改同一文件时仍需协调。

### 5. 在一个界面检查过程、结果和成本

- 查看流式回复、工具调用、执行结果和代码差异，追溯一次任务做了什么。
- 在会话中预览项目文件、Markdown、图片，下载产物或打开项目服务预览。
- 查看 Token 使用情况和费用估算，了解任务的模型消耗。
- 查看 Sandbox 的 CPU、内存和磁盘指标，以及备份版本和归档文件。

### 6. 复用已有研发工具，积累改进建议

通过连接管理向 Sandbox 提供 Git、GitLab CLI、MySQL、飞书、Meegle 和可选 Kubernetes 的本机工具配置，减少每个项目重复接入的工作。

除了完成当前任务，Agent 也可以记录代码、业务流程、知识库和开发环境中的改进机会。建议保留来源项目与会话，并支持搜索、筛选、暂缓和标记完成，便于后续集中处理。

### 7. 多端协作，跨设备接续工作

项目、会话和任务运行状态由同一个 CoCell 实例维护。在设备能够访问该实例的前提下，同一位使用者可以从不同电脑的浏览器查看项目、接续对话，共用已有工作区和知识库，减少在设备之间搬运代码、复制对话和重复准备环境的工作。

后续将适配手机和平板，围绕查看任务进度、处理待确认事项和补充任务指令优化移动端体验，让电脑上的研发任务也能在移动端跟进。

## 一个典型的工作过程

1. 创建项目，填写目标或关联飞书需求。
2. 让 Agent 阅读需求、共享知识和现有代码，讨论技术方案。
3. 在项目会话中推进开发与验证，查看工具记录、代码差异和运行预览。
4. 将可复用的结论写入知识库，处理 Agent 提出的改进建议。
5. 暂时离开时暂停 Sandbox、释放内存；项目完成后备份归档、回收磁盘空间，需要继续时恢复。

## 开发与运行

需要 Node.js 22.18+、pnpm 10、Docker，以及可用的模型认证和 API 入口。gVisor 运行环境需要宿主机的 `runsc`、CNI 和 [gVisor helper](../scripts/gvisor-helper/README.md)。

以下命令安装依赖、准备共享规则文件并启动本地 Web 开发服务，请在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
test -f .env || cp .env.example .env
mkdir -p data/docs
touch data/AGENTS.md
```

编辑 `.env`，设置 `SANDBOX_PROVIDER=gvisor`，填写 `CODEX_API_KEY`（或 `OPENAI_API_KEY`）、模型名称和所需的 `OPENAI_BASE_URL`。在 `data/AGENTS.md` 中填写工作约定，然后启动：

```sh
PORT=3001 pnpm dev
```

打开 <http://localhost:3001>。启动 Web 服务后，执行 Agent 任务还需要完成 Sandbox 环境配置：

- 构建项目镜像：`docker build -f docker/sandbox/Dockerfile -t swarm-hive-sandbox:latest .`。
- 启动 gVisor helper，配置 `GVISOR_HELPER_URL` 和对应的 bundle、网络环境，确保 Sandbox 能访问模型入口和 `SANDBOX_APPROVAL_MCP_URL`。
- 按需在连接页导入研发工具凭据；Kubernetes 通过 `COCELL_KUBECONFIG` 显式启用。

仓库也提供 [Docker Compose 配置](../docker-compose.yml)。使用前需要准备其中声明的外部 MySQL volume、CLIProxyAPI 配置与认证文件，并按运行环境核对 Docker daemon 地址和挂载路径。它目前需要本机配置，尚不是开箱即用的安装向导。

服务、镜像和部分环境变量中仍保留历史名称 `swarm-hive`，项目名称统一为 **CoCell**。

## 配置与数据

基础配置见 [`.env.example`](../.env.example)。常用选项：

| 变量 | 用途 |
| --- | --- |
| `PORT` | Web 端口；程序默认 `3000`，示例使用 `3001` |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | 模型认证 |
| `OPENAI_BASE_URL` / `CODEX_MODEL` | 模型入口与默认模型 |
| `SANDBOX_PROVIDER` | Sandbox 后端，本说明使用 `gvisor`；也支持 `docker` |
| `DOCKER_SANDBOX_IMAGE` | 项目 Sandbox 镜像 |
| `DOCKER_SANDBOX_NETWORK` | Docker Sandbox 使用的网络 |
| `SANDBOX_APPROVAL_MCP_URL` | Sandbox 可访问的人工确认工具入口 |
| `SANDBOX_AUTO_CHECKPOINT_AFTER_MS` | gVisor 自动保存运行状态并暂停的闲置阈值，默认一小时 |
| `SANDBOX_ARCHIVED_RECLAIM_AFTER_MS` | 已完成项目自动归档前的等待时间，默认一天 |
| `SANDBOX_SCHEDULED_ARCHIVE_THRESHOLD_MS` | 周期备份阈值，默认 30 分钟 |
| `CODEX_WEB_DATA_DIR` | JSON 元数据目录，默认 `data/web-state` |
| `MYSQL_URL` | 启用 MySQL 元数据存储及版本化归档管理 |

需要保留和备份的数据：

| 位置 | 内容 |
| --- | --- |
| `data/web-state/` 或 MySQL | 项目、会话及相关元数据 |
| `data/sandbox-data-archives/` | 工作区和 Codex 状态的压缩备份 |
| `data/AGENTS.md`、`data/docs/` | 共享规则和长期知识 |
| `data/improvements.sqlite` | 改进建议及处理记录 |
| `data/images/` | 上传图片 |
| `data/credentials/` | 本机连接配置与凭据 |
| gVisor 配置的 bundle / checkpoint 目录 | 使用该后端时的文件系统与运行状态 |

数据文件和对应元数据需要一起备份；共享知识与连接配置独立于项目归档维护。

## 当前定位与后续方向

当前版本面向可信用户的本机、自托管使用。后续计划：

- **移动端适配**：优化手机和平板上的布局、触控操作与任务跟进体验，支持多端协作。
- **Sandbox role 与 RBAC**：按角色控制 `glab`、`kubectl` 等工具的操作权限。

## 参与开发

```sh
pnpm typecheck
pnpm build
```

后端负责项目、会话、持久化与 HTTP/SSE 接口；`packages/agentcore` 连接 Codex App Server，`packages/sandbox` 管理 Sandbox 生命周期；React 前端展示任务和项目资源。接口契约放在 `protocol/`，共享计算放在 `util/`。

- [贡献指南](AGENTS.md)
- [项目](projects.md)
- [Sandbox](sandbox-module.md)
- [归档](archive-module.md)
- [RBAC 与 Sandbox 角色](rbac.md)
- [长期记忆](long-term-memory.md)
