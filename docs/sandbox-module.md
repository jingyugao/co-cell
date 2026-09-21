# Sandbox 模块

## 架构

```
SessionManager
  └── SandboxRuntime (container-runtime.ts)
        └── ProjectSandboxes (sandbox inventory)
              └── SandboxManager (packages/sandbox)
                    └── SandboxProvider
                          └── DockerSandboxClient (docker CLI)
```

## DockerSandboxClient

`packages/docker-sandbox/src/client.ts` — 对 `docker` CLI 的封装。

| 方法 | 说明 |
|------|------|
| `create(projectId, workDir)` | `docker run` 创建 Sandbox 容器 |
| `exec(id, cmd)` | `docker exec` 执行命令 |
| `archive(id, dest)` | `docker exec tar -czf` 打包 workspace + .codex |
| `restore(id, archivePath)` | 上传 tar.gz 到容器内，`tar -xzf` 还原 |
| `remove(id)` | `docker rm --force` 删除容器 |
| `inspect(id)` | `docker inspect` 获取容器状态 |

### Sandbox 容器规格

- **镜像**: `swarm-hive-sandbox:latest`（Dockerfile 在仓库根目录）
- **工作目录**: `/home/user/workspace`
- **Codex 状态**: `/home/user/.codex/`
- **凭据挂载**: `/home/user/.codex-web/credentials/`（只读）
- **AppServer Token**: `/home/user/.codex-web/app-server-token`（只读）
- **全局规则**: `/home/user/.codex/AGENTS.md`（只读）
- **网络**: `swarm-hive_default`（与 swarm-hive、MySQL、cliproxy 同网络）

### 归档文件结构

```bash
docker exec <container> tar -czf - -C / \
  home/user/workspace \
  home/user/.codex
```

还原时排除 `AGENTS.md`（它是只读挂载的）：
```bash
tar --exclude=home/user/.codex/AGENTS.md -xzf archive.tar.gz -C /
```

## ContainerCodexRuntime

`backend/execution/container-runtime.ts` — 业务层的 Sandbox 运行时。

### 关键操作

- **executeTurn**: 向 Sandbox AppServer 提交 Codex turn，WebSocket 流式接收结果
- **createArchive**: 委托 DockerSandboxClient.archive，产出 tar.gz
- **restoreArchive**: 上传 tar.gz → 容器内解压（排除 AGENTS.md）
- **rebuild**: 创建新容器 + 恢复归档
- **inspect**: 检查容器是否存在，不存在时标记为 `unavailable`

## 生命周期

```
项目创建 → Sandbox 懒加载（首次执行任务时创建）
     ↓
定时快照（30min 阈值）→ scheduledArchiveForProject
     ↓
标记完成 → 1 天后自动归档 → archiveProjectNow → 删除 Sandbox
     ↓
已归档 → rebuildProjectSandbox → 新容器 + 恢复最新归档
```

## Docker Compose 配置

- `DOCKER_HOST: tcp://host.docker.internal:2375` — 容器内 Docker CLI 通过 TCP 连接宿主机 daemon
- `DOCKER_SANDBOX_NETWORK: swarm-hive_default` — Sandbox 容器与 CoCell 同网络
- `extra_hosts: host.docker.internal:host-gateway` — DNS 解析宿主机

## 环境变量

| 变量 | 说明 |
|------|------|
| `DOCKER_SANDBOX_IMAGE` | Sandbox 镜像名 |
| `DOCKER_SANDBOX_NETWORK` | Docker 网络名 |
| `SANDBOX_WORKSPACE` | 容器内工作目录 |
| `SANDBOX_CREDENTIALS_HOST_DIR` | 凭据宿主机路径 |
| `SANDBOX_ARCHIVED_RECLAIM_AFTER_MS` | 完成后多久归档（默认 24h） |
| `SANDBOX_LIFECYCLE_SCAN_INTERVAL_MS` | 生命周期扫描间隔 |
| `SANDBOX_SCHEDULED_ARCHIVE_THRESHOLD_MS` | 定时归档阈值（默认 30min） |
