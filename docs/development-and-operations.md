# CoCell 开发运行与数据维护

本文说明当前版本的开发环境、Sandbox 配置和数据维护。产品介绍见[README](../README.md)，目标能力与实现进展分别见[产品定位](product-vision.md)和[产品完善进展](product-progress.md)。以下命令均在仓库根目录执行。

## 开发与运行

需要 Node.js 22.18+、pnpm 10、Docker，以及可用的模型认证和 API 入口。每个 CellBox 镜像由使用者构建，需包含 `node` 和 `codex` CLI，并提供 `CELLBOX_USER` 对应的可写 home 目录。gVisor 运行环境还需要宿主机的 `runsc`、CNI 和 [gVisor helper](../scripts/gvisor-helper/README.md)。

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

- 将 `DOCKER_SANDBOX_IMAGE` 和 `CELLBOX_CONFIG_PATH` 成对设置为一个 Box 的镜像和配置。可用 `docker build -t samplebox:latest cellbox/samplebox` 构建最小示例，并设置 `CELLBOX_CONFIG_PATH=cellbox/samplebox/sandbox.toml`；示例只挂载 Git 配置和凭据。平台在创建时会复制 `cellbox-proxy`，再启动 Codex App Server。
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

## 当前 Sandbox 的暂停与恢复

当前 gVisor 后端通过 checkpoint 保存运行状态并暂停实例，释放运行内存；再次使用时从 checkpoint 恢复。归档保存工作区与 `~/.codex`，恢复归档时使用新环境。镜像外临时安装的系统软件需要通过镜像或初始化流程重建，备份本身仍占磁盘。

具体行为与限制见[Sandbox](sandbox-module.md)和[归档](archive-module.md)。
