# CoCell 集成测试

正式入口是 `scripts/integration/`。默认测试使用真实 React 页面和可控 API 响应；真实服务、真实模型用独立命令运行，报告明确区分它们。

## 现有测试盘点与迁移

| 原有位置 | 原有覆盖 | 整理后的归属 |
| --- | --- | --- |
| `scripts/integration/conversation-reads.mjs` | 真实模型、原生历史、子/孙代理、会话隔离、读取耗时 | `model/conversation-reads.mjs`，保留实际对话断言 |
| `scripts/integration/project-lifecycle.mjs` | 真实模型生成文件/Go 服务、异步提问、Checkpoint、进程连续性、备份恢复 | `model/project-lifecycle.mjs`，复用统一配置和清理，服务样例改用平台已有 Node 标准库 |
| `backend/access/app-integration.test.ts` | Hono 路由、登录、预览 Cookie；后端依赖替身 | 保留原位置，属于进程内集成测试 |
| `backend/sessions/project-sandbox-lifecycle.test.ts`、`backend/projects/*.test.ts` | Manager、元数据短事务、状态提交、生命周期错误；运行时替身 | 保留原位置，定位业务状态问题 |
| `packages/sandbox/src/providers/cellbox/provider.test.ts` | Provider 协议、超时、轮询等替身边界 | 保留原位置，定位适配器问题 |
| `fe/**/*.test.ts(x)` | 导航、历史合并、组件静态渲染 | 保留原位置，补充浏览器测试 |
| 临时 Python/Playwright 验证脚本 | 立即进入项目、自动恢复、可编辑草稿、真实 k3s 冒烟 | 迁入 `ui/` 与 `live/`，不再依赖临时目录中的程序 |

原有两个独立脚本已迁移，配置、HTTP 请求、报告、清理不再各写一套。测试不复用已有用户项目。

## 覆盖矩阵

| 分组 | 用例 | 外部依赖 |
| --- | --- | --- |
| harness | 创建响应丢失后的资源回收；拒绝删除非本次项目；清理失败导致测试失败；报告凭证脱敏 | 无 |
| ui-desktop / ui-mobile | 暂停项目只读进入且可编辑草稿；明确恢复；unknown 不自动重放；创建立即进入；查询失败可刷新；旧会话先 SSE 后历史；Checkpoint 不挡查看；草稿隔离 | 本地 Vite、Chromium；API 为可控替身 |
| live | 真实 UI 创建/明确恢复；并发只读进入不提交恢复；明确恢复请求按项目 Box ID 单次调用 provider 并透传底层冲突；两个项目同时恢复；GET 不隐式唤醒；暂停时允许空会话元数据、拒绝任务执行；Checkpoint 只暂停、备份单独提交；文件归档恢复到新 Sandbox 后再次归档、删除 | 已部署 CoCell、Cellbox、Kubernetes 运行时和存储 |
| model lifecycle | 真实模型调用工具；Node 服务与文件下载；Checkpoint/Resume 保持 PID、实例标记和内存计数；显式备份、归档/恢复；恢复后的文件、会话上下文和重新启动服务 | live 依赖、可用模型、Sandbox 内预装 Node |
| model user-input | 独立新会话及原会话续聊连续两次真实调用异步提问工具，API 回复、原生 call ID、答复状态持久化 | live 依赖、支持原生异步提问工具的模型 |
| model reads | 真实子/孙代理、会话隔离、后续轮次上下文、原生历史新鲜度、历史与子代理接口耗时 | live 依赖、支持子代理的模型 |

`pnpm test:integration:full --list` 是当前用例清单的权威入口。模型旅程内部通过步骤报告区分多个断言阶段。

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
- 改创建、Checkpoint、Resume、错误分类或状态读取：更新 `live/`，对测试安装执行真实旅程。
- 改原生历史、子代理、异步提问、备份恢复：更新 `model/` 对应旅程，不能用伪造对话替代。
- 缺陷修复与回归断言放在同一 MR；失败先区分产品缺陷、环境故障、测试缺陷，禁止用无条件重试或跳过隐藏问题。
- GitHub Actions 在 PR 和 master 上执行类型检查、构建及默认浏览器回归，保留 7 天报告。真实集群/模型测试通过本机或有对应配置的运行环境执行。

此模块覆盖 CoCell 产品关键闭环，不包含 Cellbox API 重启、节点丢失、OSS 故障注入、冷缓存容量压测、镜像构建或外部飞书服务完整测试。故障注入应在隔离环境维护独立套件，不能混入每次运行的默认回归。

## 新版 Cellbox 适配：2026-10-18

本轮进一步精简暂停/继续路径的代码尚未部署。下方此前的部署和现场验收记录保留其历史范围，不代表本轮新改造已部署或验收。

本轮本地验证：387 项单测、`pnpm build` 和 70 项集成测试全部通过（harness 12、桌面 29、手机 29），无重跑。新增回归覆盖陈旧本地状态及 App Server 不可用不阻断生命周期提交、BUSY/未知结果仅提交一次、操作成功与后续状态查询失败分开呈现、恢复后重新计算空闲时间。集成报告：`tmp/integration/2026-10-18T08-40-33-615Z-1ab4c07c`；未执行本轮 live 验收。

项目不再有通用控制锁、维护长租约或恢复重放。只读进入和真实状态查询独立，unknown 结果由用户决定下一步。暂停/继续通过项目绑定的 Box ID 各发出一次 provider pause/resume 调用，再由项目操作记录呈现结果；不先查本地或 Cellbox phase，不做 App Server readiness、环境准备或 Sandbox 绑定重写。Cellbox 冲突和未知结果照实返回，不自动重试。

运行中纯磁盘归档和同 ID rebuild 已明确不支持。真实模型测试中的同 ID 重建改为验证 unsupported 且不改变原绑定/备份；归档恢复使用明确的 restore API。备份不自动删除旧归档，清理需明确调用 prune。真实环境与模型测试须针对已迁移的独立测试安装执行；本次本地代码验证不能代替部署验收。

Checkpoint 只负责暂停 Sandbox，不自动触发备份。工作区备份通过 `POST /api/projects/:id/backup` 单独明确提交，仅支持 paused/failed Sandbox；running 返回 409。Cellbox 仍可能返回 BUSY，CoCell 不添加资源锁、隐藏重试或幂等承诺。Resume 与 pause 均按项目绑定 Box ID 各提交一次 provider 调用，并把真实成功、失败或未知结果写入操作记录；不预判 phase、不做 App Server readiness/环境准备或项目绑定重写。归档可以从已暂停/failed 的资源生成备份，或明确复用已有备份。

此前迁移的本地结果：379 项单测通过；桌面 28/28、手机 28/28 通过。完整集成运行 66/67，唯一 harness 失败来自测试文件编辑期间缺失导入，补齐后同一 harness 定向复验 1/1 通过。本地套件没有跳过或 flaky。

部署后的新版现场验收最终为 3 项通过、3 项专项未启用，报告位于 `tmp/integration/2026-10-18T06-36-14-834Z-0a9cb819`。覆盖真实 UI、Checkpoint/显式恢复/并发恢复，以及真实文件归档恢复到新 Sandbox 后再次归档和删除；所有测试项目和 CR 已清理。现场修正历史来源重复清理及 Box NOT_FOUND 后仍发送 purge 的问题，新增用例先在原实现复现失败，修正后相关运行时单测 103 项、类型检查和构建通过。原生工具 HOME、Git 工作目录、共享预热池专项和真实模型 full 尚未执行。

## 历史修复与实测：2026-10-04

以下为旧版历史结果，其中的维护栅栏与隐式恢复行为已在 2026-10-18 改造中移除，不代表当前版本已完成真实安装验证。

首次真实模型测试发现，历史读取连接会保留 60 秒，导致紧接着的 Checkpoint/删除被 Cellbox 拒绝；子代理测试还因授权上下文未完整传递而没有生成孙代理。修复后验证如下：

- `pnpm test:integration:full`：19 项全部通过，耗时约 6.2 分钟。
- `pnpm test:integration:user-input`：补充同一会话连续两次提问、回复和持久化检查，通过，约 34 秒。
- 真实模型生命周期完整通过：生成 Node 服务、文件下载、Checkpoint/Resume 保持进程与内存、继续原会话、备份、归档删除、重建恢复文件与原会话、重新启动服务。
- 子代理测试验证了真实直属子代理及孙代理、会话隔离和上下文续聊；5 次读取采样约 23–33 ms。
- 所有真实旅程正常完成自动清理，不再等待历史读连接 60 秒空闲过期。
- 类型检查、构建、连接关闭与生命周期并发回归通过，CoCell PR CI 通过；构建保留既有大包提示。

运行时通过统一生命周期前置钩子阻止新读取、等待已有 RPC 结束并关闭连接，操作成功或失败后均释放限制；手动/自动 Checkpoint 和删除共用此流程。WebSocket 关闭等待真实握手完成，错误脱敏保留维护期间的 BUSY 分类。子代理测试传递明确用户授权及历史上下文，并在断言前保存实际代理树作为失败证据。

Cellbox 另行修复内部服务/文件 I/O 绕过生命周期接入锁的问题，同时消除 Service/Store 反向加锁。新增回归在修复前失败、修复后通过；服务层 Go race 检查和全仓 Go 测试通过，与 CoCell 联合部署完成上述真实验证。此前 API 超时缺少线程栈，不能断言它就是那次超时原因。

Checkpoint/独立备份拆分补充验收（2026-10-18，应用 `cf30a956`）：后端/SDK/util 单测 385 项、组件测试 7 项、本地 harness/桌面/手机 70 项全部通过；新版现场 3 项通过、3 项工具/预热池专项未启用，报告 `tmp/integration/2026-10-18T07-50-27-786Z-87a83c1a`。现场覆盖 Checkpoint 后立即首次 resume、独立备份、真实文件恢复与再次归档；4 个测试项目及其 Sandbox 已全部清理。模型 full 未执行。
