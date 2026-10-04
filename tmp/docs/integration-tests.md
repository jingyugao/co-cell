# CoCell 集成测试

正式入口是 `scripts/integration/`。默认测试使用真实 React 页面和可控 API 响应；真实服务、真实模型用独立命令运行，报告明确区分它们。

## 现有测试盘点与迁移

| 原有位置 | 原有覆盖 | 整理后的归属 |
| --- | --- | --- |
| `scripts/integration/conversation-reads.mjs` | 真实模型、原生历史、子/孙代理、会话隔离、读取耗时 | `model/conversation-reads.mjs`，保留实际对话断言 |
| `scripts/integration/project-lifecycle.mjs` | 真实模型生成文件/Go 服务、异步提问、Checkpoint、进程连续性、备份恢复 | `model/project-lifecycle.mjs`，复用统一配置和清理，服务样例改用平台已有 Node 标准库 |
| `backend/access/app-integration.test.ts` | Hono 路由、登录、预览 Cookie；后端依赖替身 | 保留原位置，属于进程内集成测试 |
| `backend/sessions/project-sandbox-lifecycle.test.ts`、`backend/projects/*.test.ts` | Manager、维护锁、状态提交、生命周期错误；运行时替身 | 保留原位置，定位业务状态问题 |
| `packages/sandbox/src/providers/cellbox/provider.test.ts` | Provider 协议、超时、轮询等替身边界 | 保留原位置，定位适配器问题 |
| `fe/**/*.test.ts(x)` | 导航、历史合并、组件静态渲染 | 保留原位置，补充浏览器测试 |
| 临时 Python/Playwright 验证脚本 | 立即进入项目、自动恢复、可编辑草稿、真实 k3s 冒烟 | 迁入 `ui/` 与 `live/`，不再依赖临时目录中的程序 |

原有两个独立脚本已迁移，配置、HTTP 请求、报告、清理不再各写一套。测试不复用已有用户项目。

## 覆盖矩阵

| 分组 | 用例 | 外部依赖 |
| --- | --- | --- |
| harness | 创建响应丢失后的资源回收；拒绝删除非本次项目；清理失败导致测试失败；报告凭证脱敏 | 无 |
| ui-desktop / ui-mobile | 暂停项目可进入；等待期间可输入且禁止发送；创建立即进入；创建/恢复失败与重试；刷新保留草稿；旧会话先 SSE 后历史；Checkpoint 进行中进入；切换项目停止轮询、草稿隔离 | 本地 Vite、Chromium；API 为可控替身 |
| live | 真实 UI 创建/自动恢复；单项目并发进入去重；两个项目同时恢复；GET 不隐式唤醒；暂停时允许空会话元数据、拒绝任务执行；恢复保持 box ID；再次 Checkpoint 验证 App Server | 已部署 CoCell、Cellbox、Kubernetes 运行时和存储 |
| model lifecycle | 真实模型调用工具；Node 服务与文件下载；Checkpoint/Resume 保持 PID、实例标记和内存计数；备份/归档/恢复；恢复后的文件、会话上下文和重新启动服务 | live 依赖、可用模型、Sandbox 内预装 Node |
| model user-input | 独立新会话真实调用异步提问工具，API 回复、原生 call ID、答复状态持久化 | live 依赖、支持原生异步提问工具的模型 |
| model reads | 真实子/孙代理、会话隔离、后续轮次上下文、原生历史新鲜度、历史与子代理接口耗时 | live 依赖、支持子代理的模型 |

`pnpm test:integration:full --list` 是用例清单的权威入口。目前包括 2 个基础设施用例、6 个桌面和 6 个手机用例、2 条真实服务旅程、3 条真实模型旅程。模型旅程内部通过步骤报告区分多个断言阶段。

## 运行

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:integration
pnpm test:integration:live
pnpm test:integration:full
pnpm test:integration:reads
pnpm test:integration:lifecycle
pnpm test:integration:user-input
```

默认 `test:integration` 不访问集群、不调用模型。`live` 会创建和删除临时项目；`full`、`reads`、`lifecycle`、`user-input` 使用真实模型并消耗 token。真实测试运行一个 worker，只有明确的并发用例同时操作两个项目；测试失败不自动重跑。

仅列清单不需要凭证：`pnpm test:integration:full --list`。可追加 Playwright 参数，例如 `pnpm test:integration --grep 'paused session'`。

## 配置

把 `deploy.env.example` 复制为仓库根目录 `deploy.env`。这是本机部署信息，不提交 Git，也不进入 Docker 构建上下文；环境变量优先于文件。文件使用 dotenv 格式，不展开 `$HOME`、`~` 或变量引用。

已有 Helm 安装推荐配置 `COCELL_E2E_KUBE_CONTEXT`、`COCELL_E2E_NAMESPACE`、`COCELL_E2E_HELM_RELEASE`、`COCELL_E2E_SERVICE`。测试读取已有 release 的 `publicUrl` 和 Secret，凭证仅保存在进程内，并自动建立、关闭 `127.0.0.1` 端口转发；不创建工具 Pod，不使用 kubectl 的默认 context。

也可以直接设置 `COCELL_E2E_BASE_URL` 和 `COCELL_E2E_ACCESS_TOKEN`。已有端口转发的 Host 与应用公开域名不同时，设置 `COCELL_E2E_PUBLIC_URL`。显式 `BASE_URL` 优先使用直连方式。

| 可选配置 | 默认值 / 用途 |
| --- | --- |
| `COCELL_E2E_MODEL` | `gpt-6-luna`；模型旅程使用的实际模型 |
| `COCELL_E2E_OPERATION_TIMEOUT_MS` | 300000；单次项目操作等待上限 |
| `COCELL_E2E_TURN_TIMEOUT_MS` | 600000；单轮模型与项目空闲等待上限 |
| `COCELL_E2E_READ_LATENCY_MS` | 2000；原有历史/子代理读取耗时回归阈值 |
| `COCELL_E2E_OUTPUT_DIR` | `tmp/integration/<时间-随机后缀>` |
| `COCELL_E2E_UI_PORT` | 自动选择空闲 IPv4 loopback 端口 |
| `COCELL_E2E_KEEP_PROJECT` | 仅 `1` 表示显式保留本次项目 |

## 结果、耗时与清理

每次运行生成 HTML、JSON、JUnit，以及每条真实旅程的 `resources.json`。它记录本次资源 ID、步骤耗时、HTTP 耗时和清理结果；失败时不丢弃证据。UI 用例失败保留截图和 trace；真实环境禁用网络 trace，代理仅在 Node 中添加 operator token。

查看报告：`pnpm exec playwright show-report tmp/integration/<运行目录>/html`。

真实测试统一使用随机 run ID 和项目名前缀；成功、失败或正常中断后均尝试删除本次项目，并验证它们及绑定 Sandbox 已消失。自动清理失败会让测试失败，不能以“用例通过”覆盖它。`SIGKILL`、机器掉线或服务故障无法保证即时清理；恢复服务后使用对应台账：

```sh
pnpm test:integration:cleanup tmp/integration/<运行目录>/artifacts/<用例>/resources.json
```

清理命令校验目标安装和本次项目归属，不会按“所有测试项目”批量删除。报告目录默认不提交 Git。

UI 交互耗时与实际恢复耗时分别记录；普通集成测试不把单次 1 秒作为硬性 SLA。模型历史读取保留原有 5 次采样阈值，用于回归提醒，不应解读为容量压测。

## 重点维护规则

- 改项目入口、草稿、导航或异步就绪：补充/更新 `ui/`，跑桌面和手机回归。
- 改创建、Checkpoint、Resume、幂等或状态读取：更新 `live/`，对测试安装执行真实旅程。
- 改原生历史、子代理、异步提问、备份恢复：更新 `model/` 对应旅程，不能用伪造对话替代。
- 缺陷修复与回归断言放在同一 MR；失败先区分产品缺陷、环境故障、测试缺陷，禁止用无条件重试或跳过隐藏问题。
- GitHub Actions 在 PR 和 master 上执行类型检查、构建及默认浏览器回归，保留 7 天报告。真实集群/模型测试通过本机或有对应配置的运行环境执行。

此模块覆盖 CoCell 产品关键闭环，不包含 Cellbox API 重启、节点丢失、OSS 故障注入、冷缓存容量压测、镜像构建或外部飞书服务完整测试。故障注入应在隔离环境维护独立套件，不能混入每次运行的默认回归。

## 首次整理验证：2026-10-04

被测服务为 master `4498d8aa`。本地 14 个基础设施/桌面/手机用例通过；2 条真实服务旅程通过（包含两个项目同时恢复）。`pnpm typecheck`、`pnpm build` 通过。构建仍有既有的大包提示。

3 条模型旅程已实际执行，但整组尚未通过：

- 生命周期：模型已生成并启动 Node HTTP，文件下载、HTTP 字段及进程计数验证通过；随后立即 Checkpoint 失败。服务端原因为 `Box has active service requests`，因此本轮未执行后续 Resume、备份和恢复断言。
- 异步提问：独立新会话的真实提问、API 回复和回复持久化均通过；最终删除项目仍因活动服务请求失败，整个用例判失败。曾在已有会话续聊时遇到模型报告没有该工具，故此能力作为独立用例维护。
- 子代理读取：本次主代理回复缺少孙代理结果，断言失败；后续隔离/延迟测量未执行。不能把模型文字描述当成子代理已真实运行的证据。

Checkpoint/删除问题的代码线索是 `backend/execution/app-server-reader.ts` 保留读连接 60 秒，而运行时的 Checkpoint/删除路径未主动释放该连接。实测空闲连接释放后可通过台账命令清理。测试保留即时操作断言，不加固定等待或自动重试掩盖问题。后续应优先修复运行时的读连接生命周期，再重跑三条模型旅程；本次不改产品运行时代码。

首次并发真实服务验证还曾遇到 Cellbox API 操作超时；测试安装的 API 用原镜像重启并回收本次资源后，重新验证通过。该结果不代表故障注入或长期稳定性验证。
