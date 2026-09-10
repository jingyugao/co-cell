# E2B 接入与生命周期

Web 后端管理项目与沙箱的映射。每个项目拥有一个独立 E2B 沙箱，多个会话共享其中的工作目录、依赖和工具；每个会话有独立的 Codex thread。Codex TypeScript SDK 与原生 CLI 均在沙箱内部运行。

```text
浏览器 → Web API → E2B commands
                    ↓
          沙箱内 Node → Codex SDK → Codex CLI → 模型与工具
                    ↓
             SDK JSONL → Web SSE → 浏览器
```

## 连接配置

应用默认兼容 `~/.data/e2b/client/demo.mjs` 使用的本机 E2B 部署。普通任务通过仓库的 E2B SDK 连接；模板构建和模板验证另外依赖已安装的 `~/.data/e2b/client/config.mjs`，见 [模板管理](template-management.md)。

| 变量 | 默认值或用途 |
| --- | --- |
| `E2B_ENABLED` | `false` 禁用 E2B |
| `E2B_API_KEY` | 显式 E2B key，优先于文件 |
| `E2B_API_KEY_FILE` | 默认 `~/.data/e2b/config/api-key` |
| `E2B_API_URL` | 默认 `http://127.0.0.1:13000` |
| `E2B_SANDBOX_URL` | 默认 `http://127.0.0.1:13002` |
| `E2B_DOMAIN` | 默认 `localhost` |
| `E2B_TEMPLATE` | 首次初始化默认模板，未设置时为 `base` |
| `E2B_WORKSPACE` | 默认 `/home/user/workspace` |
| `E2B_ARCHIVE_ENABLED` | 本地 E2B 默认启用暂停一周后的快照归档；`false` 关闭 |
| `E2B_ARCHIVE_DIR` | 压缩归档持久化目录，默认 `data/sandbox-archives` |
| `E2B_LOCAL_DATA_DIR` | 本地 E2B 数据目录，默认 `~/.data/e2b` |
| `E2B_INSPECT_BINARY` | 原生快照依赖检查工具，默认 `data/tools/inspect-build` |
| `CODEX_EXECUTION_MODE` | 默认有 E2B 和模型 key 时为 `e2b`，否则为 `local` |

执行 E2B 项目需要 E2B key 以及 `CODEX_API_KEY` 或 `OPENAI_API_KEY`。模型 key 通过进程环境提供，不放入命令行或浏览器响应。`OPENAI_BASE_URL` 必须能从沙箱访问：该地址中的 `127.0.0.1` 指沙箱自身。

配置模型代理时，默认注册 HTTP Responses provider 并关闭 WebSocket，避免仅支持 `POST /v1/responses` 的代理在 WebSocket 握手时返回 404。额外 `CODEX_CONFIG_JSON` 和 `CODEX_CONFIG_OVERRIDES_JSON` 会传给执行环境；其中的路径必须适用于沙箱。

## 工作区与权限

通过项目页面创建项目，首次任务才创建沙箱。新项目不会自动复制本机代码，可以让 Agent 克隆仓库或创建文件。工作目录必须位于沙箱 `/home/user/` 下，应用保留的 `.codex` 和 `.codex-web` 目录不能作为项目工作区。

E2B 内 Codex 固定为 `danger-full-access`、`approvalPolicy: never`，命令网络访问开启。它可以在沙箱内安装依赖、访问工具和修改文件，不再额外使用 Codex 的只读或 `workspace-write` 文件系统限制。项目工作范围由 `AGENTS.md` 指令约定；E2B VM 提供与宿主环境的隔离。已有 E2B 会话下一轮也使用此策略。

本机个人 Codex 配置、MCP、skills、代码和凭据不会隐式全部复制。共享文件与“连接与凭据”页面维护的内容分别按下述机制同步。

## 共享规则、文档与连接

侧栏“共享文件”管理 `data/AGENTS.md` 和 `data/docs/`。每轮启动前读取中心文件，分别同步到沙箱的 `/home/user/.codex/AGENTS.md` 和 `/home/user/.codex/docs/`；`CODEX_HOME` 为 `/home/user/.codex`。

- 共享文件是每个沙箱各自的副本，不是共享可写磁盘；修改下一轮生效，不会唤醒所有暂停沙箱。
- 已运行的任务继续使用启动时的版本。沙箱内修改共享副本不会回写中心，下轮会被覆盖；项目工作区自己的 `AGENTS.md` 保留。
- 中心规则删除后，下轮写入空规则；文档目录每轮替换，中心删除的文档也会移除。同步失败时不启动 worker。
- 编辑器支持不超过 1 MiB 的 UTF-8 文本、子目录、版本冲突检测和未保存提示；接口限制访问范围并拒绝符号链接。

可在共享规则中要求实质任务结束后输出文本复盘，并指引 Agent 按需读取 `~/.codex/docs/`。这属于模型指令约定，复盘保存在普通会话文本中，不另发模型请求，也不保证固定输出格式。

“连接与凭据”页面可以显式导入本机 GitLab、MySQL、Git、飞书和飞书项目配置。凭据在宿主加密保存，下一轮同步到本应用的项目沙箱；它们不进入模板、共享文档或浏览器的连接详情。页面展示连接身份与最近检查结果，具体可用权限取决于导入的身份。

## 生命周期

| 操作或状态 | 行为 |
| --- | --- |
| 首次任务 | 创建项目沙箱并准备 SDK、共享文件和连接 |
| 同项目其他会话 | 复用沙箱和文件，使用各自的 thread |
| 任务运行中 | 每分钟将暂停 TTL 续为从现在起 3 小时；同项目多个会话共享工作区并行执行 |
| 一次使用结束 | 再续期 3 小时；读取工作区、打开服务预览也算使用 |
| 没有继续使用 | 巡检仅查询状态，不续期、不主动暂停；TTL 到期由 E2B 保存快照并暂停 |
| 连续暂停超过 7 天 | 巡检压缩完整快照依赖图并存入归档存储，不唤醒 VM |
| 使用已归档项目 | 校验并恢复快照文件，再连接原沙箱 ID；原项目、会话和 thread 保留 |
| 下一轮任务 | 恢复同一沙箱，清理本应用遗留 worker 后继续 |
| 停止任务 | 取消 Codex 进程与子进程，保留工作区 |
| 关闭页面 | 后台任务继续；重连后读取状态快照 |
| 重启 Web 服务 | 正常关闭取消活动任务，沙箱仍按空闲策略或到期暂停；异常退出后将遗留运行状态标为中断，不自动重放任务 |
| 删除会话 | 删除网页历史与附件，保留项目沙箱 |
| 删除项目 | 删除全部会话并销毁项目沙箱；有任务运行时拒绝删除 |

暂停 TTL 固定为 3 小时，旧的 `E2B_TIMEOUT_MS` 不再控制生命周期。E2B 单次连续运行硬上限仍独立存在：平台会将截止时间截断到「本次启动时间 + 团队 max_length_hours」，即使续期返回成功也不能突破。平台上限小于 3 小时时，必须先提高平台限制，才能申请完整的 3 小时 TTL。

本地平台可由管理员执行 `scripts/e2b/set-team-sandbox-lifetime.sql`，仅调整指定团队的上限，例如 168 小时。脚本不会随应用启动自动执行。团队配置缓存最多 5 分钟；已运行实例保留旧上限，需要在任务结束后暂停、再恢复才使用新上限。168 小时仍是硬上限，不代表无限连续运行。

项目持久化沙箱 ID、`lastActiveAt`、`pausedAt`、归档引用和最近观察状态（`starting`、`ready`、`paused`、`unavailable`、`archiving`、`archived`、`restoring`）；后端内存保存连接以及运行任务、读取操作的计数。每分钟巡检、获取已有连接和任务结束时都向 E2B 管理 API 核对实际状态，并同步项目及关联会话。首次观察到暂停时记录 `pausedAt`，旧记录不会猜测历史暂停时间；恢复运行后清空，因此按连续暂停时长判断归档。命令接口的 404 不能直接判定沙箱丢失，必须查询管理 API 区分已暂停和不存在。

续期后核对实际截止时间，被平台硬上限截断时记录 `sandbox.lease_capped`；状态转换记录 `sandbox.state_changed`；归档/恢复分别记录 `sandbox.archived`、`sandbox.archive_restored`。新创建的沙箱配置到期暂停和显式恢复，减少 Web 异常退出后的工作区丢失风险。服务重启后可以继续原会话，但这不是执行进程的断点续跑。若原沙箱已被外部删除，任务会报错，不会创建空沙箱冒充原工作区。

### 归档存储

`server/sandboxes/archive-storage.ts` 定义 `SandboxArchiveStorage` 的 `put/get/delete` 接口。当前实现将 `.tar.gz` 流式写到本地持久化目录，原子落盘并记录大小和 SHA256；恢复下载时先校验，再交给快照适配器。后续 OSS 实现只需替换该接口。

`LocalSnapshotArchive` 针对本机 E2B：通过只读 SQL 获取快照 build，用 `inspect-build` 找出磁盘与内存的完整依赖图，再通过无网络临时 Docker 容器读取原生快照文件，归档 manifest 和全部依赖层。需要本地 Docker 权限、E2B Compose 的 postgres 服务以及 `bash scripts/e2b/build-archive-inspector.sh` 生成的检查工具。不会启动沙箱内的业务进程。

归档失败保留暂停状态和原快照，后续巡检可重试；恢复失败保留归档引用，不创建空沙箱。归档过程与项目连接串行，避免发送消息与归档竞争。恢复验证文件路径、类型、校验和以及原 sandbox/build 对应关系；已有层必须相同，缺失层才从归档恢复。

当前版本只做压缩备份，**保留 E2B 原快照及其数据库记录**。原生快照共享增量依赖，未经全平台引用检查不能安全删除，因此本版不会腾空原 E2B 存储，也不保证 E2B 元数据被外部删除后的灾难恢复。此沙箱存储归档与项目列表的手动「已归档」分组相互独立。

## 沙箱管理与诊断

`/#sandboxes` 展示当前 E2B key 可见的运行中和暂停沙箱，包含未关联本应用的沙箱。项目归属以本应用持久化的映射为准。暂停沙箱不会仅为展示指标而恢复；缺失采样显示为未知，不计作零用量。

页面展示 CPU/内存配置与采样、磁盘采样、模板、时间和关联会话。运行资源合计是配置统计，不代表计费金额。服务端合并并发刷新并限制指标查询并发；没有历史指标时，仅对确认不会自动唤醒的运行中沙箱尝试即时指标接口。

工具详情和 SDK 事件沿用同一界面。附件上传至对应沙箱后作为 `local_image` 提交；Git 差异从项目目录读取；原始工具消息从沙箱的 Codex rollout 按 thread 校验和字节游标分页。

任务问题先看 [运行日志](runtime-logging.md)；模型容量错误的四档原通道重试见 [模型过载重试](model-overload-retries.md)。
