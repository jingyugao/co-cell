# swarm-hive 项目说明

swarm-hive 是基于 TypeScript、Codex App Server 和 React 的单用户 Web 编码工作台。每个项目对应一个本地 Docker Sandbox；项目内多个会话共享工作区，各自保留 Codex thread。页面展示执行事件、工具详情、代码差异、文件和服务预览。

Docker 是唯一 Sandbox provider。Web 服务持有 Docker socket 的宿主机权限，本地部署不把项目容器当作安全隔离边界，只适用于可信用户。

## 快速启动

需要 Node.js 22.18+、pnpm 10、Docker Compose 和模型 API key。

```sh
pnpm install --frozen-lockfile
test -f .env || cp .env.example .env
```

在 `.env` 中填写 `CODEX_API_KEY`（或 `OPENAI_API_KEY`）；使用模型代理时设置 `OPENAI_BASE_URL`。开发模式：

```sh
PORT=3001 pnpm dev
```

生产模式可通过 Makefile 构建 Web 镜像和 `swarm-hive-sandbox:latest` 项目镜像，再启动 Compose 服务：

```sh
make up
```

若直接使用 Compose，先在宿主机执行 `docker build -f docker/sandbox/Dockerfile -t swarm-hive-sandbox:latest .`，再执行 `docker compose up -d --build`。

打开 http://localhost:3001 。创建项目和会话本身不创建容器，首次发送任务时才创建。同一项目后续会话复用容器。

## 配置与持久目录

完整配置见 `.env.example`。常用变量：

| 变量 | 用途 |
| --- | --- |
| `PORT` | HTTP 端口，应用默认 `3000`，Compose 固定为 `3001` |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | 模型认证，前者优先 |
| `OPENAI_BASE_URL` | 容器可访问的 Responses API 地址 |
| `CODEX_MODEL` | 默认模型 |
| `DOCKER_SANDBOX_IMAGE` | 项目容器镜像，默认 `swarm-hive-sandbox:latest` |
| `SANDBOX_WORKSPACE` | 项目容器内工作目录，默认 `/home/user/workspace` |
| `SANDBOX_ARCHIVED_RECLAIM_AFTER_MS` | 已完成项目自动归档前的等待时间，默认一天 |
| `SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS` | 项目生命周期巡检间隔，默认一分钟 |
| `CODEX_WEB_DATA_DIR` | JSON 元数据及旧数据导入目录，默认 `data/web-state` |
| `MYSQL_URL` | 配置后使用 MySQL 保存项目和会话元数据 |

Sandbox 内 Codex 固定使用 `danger-full-access` 和命令网络访问。项目范围由共享及项目 `AGENTS.md` 约定，而不是依赖容器提供安全隔离。

需要单独备份：

| 路径 | 内容 |
| --- | --- |
| `data/web-state/` 或 MySQL | 项目、会话元数据 |
| `data/images/` | 上传图片 |
| `data/improvements.sqlite` | 改进建议 |
| `data/AGENTS.md`、`data/docs/` | 下发给项目的共享规则和知识库 |
| `data/credentials/` | 连接凭据 |
| `data/logs/` | 运行诊断日志 |

项目工作区和 `~/.codex` 只存在于当前 Docker 容器中。项目归档会立即删除并解绑容器，不保留 Sandbox 快照；重建会创建全新的空容器，不能恢复旧工作区或旧容器内的 Codex thread。

## 执行与生命周期

- 同一会话同时只运行一个 turn；同项目不同会话可以并行，文件和端口冲突由使用者协调。
- 关闭或刷新浏览器只取消订阅，不停止任务。Web 服务重启后会重新观察已被 Sandbox App Server 接受的活动 turn，不会重复提交 prompt；尚未被接受的启动中任务仍会取消。
- 删除会话只删除网页历史和附件，保留项目 Sandbox；删除项目会删除全部会话和当前容器。
- 项目可从“使用中”标记为“已完成”，到期后巡检自动归档并删除容器。
- 归档项目不能进入或执行任务，只展示“重建 Sandbox”。重建成功后项目回到使用中。
- Docker 使用 host network，项目服务端口直接位于宿主机；不同项目使用同一端口会冲突。
- 连接页导入的 `glab`、MySQL、Git、Lark、Meegle 和 Kubernetes 凭据会在下一轮任务准备阶段同步到 Sandbox。

## 开发与验证

```sh
pnpm typecheck
pnpm build
tests=$(rg --files backend fe util | rg '\.test\.tsx?$' | tr '\n' ' ')
node --import tsx --test $tests
```

代码结构：

| 目录 | 职责 |
| --- | --- |
| `backend/projects/` | 项目记录、状态和归档操作 |
| `backend/sessions/` | 会话、任务、订阅及跨模块协调 |
| `backend/execution/` | Container runtime、worker 和执行事件 |
| `backend/sandboxes/` | 项目绑定、Docker provider、资源清单和预览 |
| `packages/sandbox/` | provider-neutral Sandbox 生命周期协调层 |
| `packages/docker-sandbox/` | Docker 命令传输实现 |
| `packages/agentcore/` | Codex App Server JSON-RPC 适配层 |
| `backend/connections/`、`backend/shared-files/` | 凭据和共享文档 |
| `protocol/` | 前后端数据契约 |
| `fe/features/` | 各业务页面和局部逻辑 |

## 文档索引

- [项目开发指南](AGENTS.md)
- [项目与会话](projects.md)
- [项目文件与资源链接](workspace-resources.md)
- [Agent 改进建议](improvements.md)
- [运行日志](runtime-logging.md)
- [原始 HTTP 抓包](http-capture.md)
- [模型过载重试](model-overload-retries.md)
- [Kubernetes 开发调试权限](kubernetes-access.md)
