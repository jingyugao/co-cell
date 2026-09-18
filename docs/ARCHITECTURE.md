# 系统架构

## 概览

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (React)                         │
│  App.tsx ── ProjectsPage ── Chat ── SandboxManager ── ...  │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP/WS (Hono)
┌──────────────────────────▼──────────────────────────────────┐
│                    Backend (Node.js)                        │
│  SessionManager ── ProjectService ── ArchiveManager        │
│        │                  │              │                  │
│  ContainerCodexRuntime ──┴── DockerSandboxClient           │
└──────────────────────────┬──────────────────────────────────┘
                           │ Docker CLI / TCP
┌──────────────────────────▼──────────────────────────────────┐
│                    Docker Engine                            │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐        │
│  │ Sandbox 1 │  │ Sandbox 2    │  │ Sandbox N     │        │
│  │ workspace │  │ workspace    │  │ workspace     │        │
│  │ .codex    │  │ .codex       │  │ .codex        │        │
│  │ AppServer │  │ AppServer    │  │ AppServer     │        │
│  └──────────┘  └──────────────┘  └───────────────┘        │
│  ┌──────────┐  ┌──────────────┐                             │
│  │ MySQL    │  │ Cliproxy     │                             │
│  └──────────┘  └──────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

## 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 会话管理 | `backend/sessions/manager.ts` | 会话 CRUD、项目关联、turn 执行编排 |
| 项目服务 | `backend/projects/service.ts` | 项目生命周期、Sandbox 绑定、状态机 |
| 归档模块 | `backend/archives/` | 版本链归档、保留策略、文件清理 |
| 容器运行时 | `backend/execution/container-runtime.ts` | Codex 执行、Sandbox 通信、文件操作 |
| 沙箱管理 | `backend/sandboxes/` | Docker 容器创建/监控/回收 |
| Web 状态 | `backend/infra/storage/web-state.ts` | MySQL/JSON 双存储后端 |

## 数据流

### 对话流程
```
用户输入 → App.tsx → POST /api/sessions/:id/turns
  → SessionManager.executeTurn()
  → ContainerCodexRuntime → Docker exec → Sandbox AppServer
  → Codex SDK (WebSocket) → Cliproxy → LLM API
  → 结果流式返回 → App.tsx → TurnItems 渲染
```

### 归档流程
```
定时扫描(1min) → 检查阈值(30min) → scheduledArchiveForProject()
  → SQLite checkpoint → docker exec tar -czf → 存 .tar.gz
  → ArchiveManager.create() → archive_versions 表
  → retain(1) 原子清理旧版本
```

### 恢复流程
```
用户点击重建 → rebuildProjectSandbox()
  → Docker 创建新容器 → restoreArchive() 解压 tar.gz
  → AppServer 启动 → 读取 restored thread_history.sqlite
  → 旧会话 threadId 可继续
```

## 协议层

`protocol/types.ts` 定义所有共享类型：Project, Session, Turn, SandboxState, Settings 等。

## 前端路由

`fe/lib/navigation.ts` 管理页面状态：chat, projects, sandboxes, files, connections, improvements。归档浏览以模态框覆盖层形式嵌入，不占独立路由。