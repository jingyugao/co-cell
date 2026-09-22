# Sandbox

Sandbox 提供项目代码、命令工具和 Agent 的执行环境。每个项目绑定一个 Sandbox，项目内的会话复用环境。当前使用 gVisor，通过 checkpoint 在闲置时释放运行内存，在需要时恢复工作。

## 暂停与恢复

1. 首次执行任务时创建环境，启动持久运行的 Codex App Server。
2. 会话使用环境时，生命周期管理器记录使用状态。
3. 没有活动使用者且达到闲置阈值时，调用 gVisor checkpoint 保存运行状态，并停止实例。
4. 再次访问时，管理器根据保存的 checkpoint 恢复实例，重新连接后继续工作。

`SANDBOX_AUTO_CHECKPOINT_AFTER_MS` 控制自动 checkpoint 的闲置阈值，默认一小时。运行状态写入磁盘后释放实例运行内存，因此可以同时保留多个项目而不让所有环境持续占用内存。

暂停保存运行状态，用于短期闲置；[归档](archive-module.md)保存项目数据并回收环境，用于长期存放。恢复运行状态还依赖对应的文件系统 bundle 和 checkpoint 文件。

## 环境中的内容

| 位置 | 用途 |
| --- | --- |
| `/home/user/workspace` | 默认项目工作区 |
| `/home/user/.codex` | Codex 配置、原生会话及相关状态 |
| `/home/user/.codex/AGENTS.md` | 共享工作约定 |
| `/home/user/.codex/docs` | 从共享知识库同步的文档 |
| `sandbox.toml` 定义的挂载 | Git、GitLab、数据库、飞书等工具配置 |

共享规则与知识的维护见[长期记忆](long-term-memory.md)，工具操作权限的设计见[RBAC](rbac.md)。[工具挂载](tool-mounts.md)描述通过 Sandbox wrapper 转发调用、经授权后使用宿主机 CLI 和凭证执行的设计。

## 模块分工

| 模块 | 职责 |
| --- | --- |
| `backend/execution/container-runtime.ts` | 任务执行、环境准备、App Server 连接和文件访问 |
| `backend/sandboxes/project-sandboxes.ts` | 项目与 Sandbox 的绑定和使用租约 |
| `packages/sandbox/src/manager.ts` | 创建、连接、闲置 checkpoint、恢复与回收 |
| `packages/sandbox/src/providers/gvisor/` | gVisor provider，与宿主 helper 通信 |
| `scripts/gvisor-helper/server.mjs` | 调用 runsc，管理网络、checkpoint 和端口转发 |
| `packages/docker-sandbox/` | Docker 后端及其数据备份、恢复实现 |

生命周期与具体 provider 分开管理。运行状态保存使用 `checkpoint/restore`，文件备份恢复使用独立的数据归档接口。

## 运行配置

| 配置 | 用途 |
| --- | --- |
| `SANDBOX_PROVIDER=gvisor` | 选择 gVisor 后端 |
| `DOCKER_SANDBOX_IMAGE` | 提供环境文件系统的项目镜像 |
| `GVISOR_HELPER_URL` | 宿主 helper 地址 |
| `GVISOR_BUNDLE_ROOT` | 文件系统 bundle 目录 |
| `GVISOR_NETNS_ROOT` | 网络 namespace 目录 |
| `GVISOR_APP_SERVER_HOST` | CoCell 连接 App Server 的地址 |
| `SANDBOX_AUTO_CHECKPOINT_AFTER_MS` | 自动 checkpoint 的闲置阈值 |

宿主需要 runsc 和 CNI。部署命令见 [gVisor helper 说明](../scripts/gvisor-helper/README.md)，挂载配置由所选 Box 的 `sandbox.toml` 提供。
