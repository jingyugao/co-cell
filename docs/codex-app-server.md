# Codex App Server

## 角色

Codex App Server 是运行在每个 Sandbox 容器内的 Node.js 进程，负责：

1. 通过 WebSocket 与 CoCell 后端通信
2. 调用 Codex SDK 执行 Agent 任务（读写文件、执行命令等）
3. 维护对话线程状态（thread history）
4. 管理 MCP 服务器（审批等）

```
CoCell Backend ←→ WebSocket ←→ Codex App Server (Sandbox 内)
                                         ↓
                                    Codex SDK
                                         ↓
                                    Cliproxy
                                         ↓
                                    LLM API
```

## 安装与配置

通过引导命令自动安装：
```bash
npm install --prefix /home/user/.local --global @openai/codex@0.153.4
```

启动参数由 `appServerArgs(modelConfig, overrides)` 生成，包括：
- `CODEX_API_KEY` — API 认证
- `OPENAI_BASE_URL` — API 代理地址
- `CODEX_MODEL` — 模型名
- `CODEX_APP_SERVER_ARGS` — MCP 服务器、审批工具配置

## 状态存储

App Server 将所有状态存储在 `/home/user/.codex/`：

| 文件 | 内容 |
|------|------|
| `thread_history_1.sqlite` | 线程索引（threadId → rollout 映射） |
| `state_5.sqlite` | 运行时状态 |
| `goals_1.sqlite` | 目标/任务状态 |
| `logs_2.sqlite` | 执行日志 |
| `memories_1.sqlite` | 内存/记忆 |
| `sessions/YYYY/MM/rollout-*.jsonl` | 对话 rollout 数据 |
| `AGENTS.md` | 全局规则（只读挂载） |
| `config.toml` | 运行时配置 |
| `installation_id` | 安装标识 |

### 线程恢复机制

当用户继续旧会话时：
1. 前端发送 threadId
2. `ContainerCodexRuntime` 将 threadId 传给 App Server
3. App Server 查询 `thread_history_1.sqlite` 找到线程
4. 从对应的 `rollout-*.jsonl` 读取历史对话
5. 将上下文发送给 LLM 续写

### 归档兼容性

**关键问题**：`thread_history_1.sqlite` 使用 SQLite WAL 模式。归档时如果未做 checkpoint，恢复后的数据库文件与新的 App Server 进程不兼容，App Server 会丢弃并重建。

**解决方案**：每次创建归档前执行 `PRAGMA wal_checkpoint(TRUNCATE)`，将 WAL 内容合并到主文件。详见 [archive-module.md](archive-module.md)。

## 网络

- App Server 监听 `0.0.0.0:36606` (WebSocket)
- CoCell 通过容器名 DNS 连接：`http://<sandbox-name>:36606`
- LLM API 调用通过 cliproxy 代理：`http://cliproxy:8317/v1`

## MCP 审批

App Server 配置了 `swarm_approvals` MCP 服务器：
- URL: `http://swarm-hive:3001/mcp/approvals`
- 在 sandbox 内执行危险操作前请求用户批准
- 通过 `CODEX_APP_SERVER_ARGS` 环境变量注入配置

## 版本管理

`SandboxVersion` 组件在前端展示镜像版本链，支持检测过期镜像。

```typescript
// 镜像身份
interface SandboxImageIdentity {
  id: string;       // sha256:...
  version: string;  // 0.1.1
  createdAt: string;
  reference: string; // swarm-hive-sandbox:latest
}
```

## 常见问题

### "no rollout found for thread id"
App Server 的 `thread_history_1.sqlite` 中找不到该 threadId。原因：
1. 归档时未做 SQLite checkpoint（已修复）
2. Sandbox 重建后旧线程索引丢失
3. App Server 版本升级导致格式不兼容

### "Reconnecting... waiting for network"
WebSocket 连接断开。可能原因：
- Sandbox 容器被暂停/删除
- App Server 进程崩溃
- 网络不可达
- LLM API（cliproxy）不可用
