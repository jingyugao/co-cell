# CoCell 迁移新版 Cellbox 与并发、重试简化方案

日期：2026-10-18。

状态：适配代码已在 feature 分支实现，并已按用户授权切换主安装；本地检查及新版现场回归已完成。用户确认保留旧数据供后续迁移，旧 Sandbox 与旧归档暂不可用。75 个原有项目、188 个会话、28 个旧 CR 均已核对保留；测试安装未操作。第 2–6 节的“当前/原有”源码盘点描述改造前基线；实施和部署结果以本节及第 12 节为准。

检视基线：CoCell `d6c3815343a789c70490763b5a847aa8a0c5a8b6`；Cellbox `6465c3e4b1205cde619f2681ede48d7ce1173b6b`，包括 `f0921f2` 的模板版本改造与 `6465c3e` 的单进程、SQLite 和生命周期简化。以下事实针对这些版本，后续实现前需重新核对目标提交和实际安装。

本轮暂停/继续路径精简属于后续本地改造，尚未部署；第 12 节的部署与现场验收记录保持为此前版本的历史事实，不能视为本轮改造的部署验收。

### 已实现的入口和行为

- Provider/client 使用 template/revision/build 与显式 suspend/resume/destroy/activate；不发送幂等键，不重放写请求。默认配置为 `CELLBOX_TEMPLATE_ID` / `CELLBOX_REVISION_ID` 二选一，`CELLBOX_PROFILE` 仅选择运行规格。
- 新增明确的 `POST /api/projects/:id/sandbox/create` 和 `sandbox/restore`；前端进入项目只 GET。旧 `open` 也只读，旧 `rebuild` 保留兼容但同 ID 重建明确拒绝。
- 删除项目控制锁、维护长租约、创建总锁、按周占用、恢复接管与重放、镜像全局队列/预占、Cellbox lease/route 管理。元数据保留短事务；旧回调不能覆盖已切换的本地 Sandbox 绑定。
- 项目暂停/继续从项目绑定的 Cellbox Box ID 出发，分别单次调用 provider pause/resume，再把真实结果写入项目操作记录；不按本地 phase 短路或预判，不检查 App Server readiness、不做环境准备，也不重写项目 Sandbox 绑定。Provider 提交一次 Cellbox 生命周期动作并读取该 operation 结果；Cellbox 的 BUSY/CONFLICT/未知结果照实返回，不自动重试。
- 返回 Cellbox 的错误 status/code 和脱敏 message；未确认写请求保存 unknown。远端成功响应无法读取或解析时，CoCell 返回错误 HTTP 状态并保留 upstreamStatus，避免把 unknown 当作成功。Checkpoint 只暂停 Sandbox；备份由用户通过独立入口明确提交，结果分别展示。定时政策不接管或重做 running/failed/unknown 的操作。
- 归档只针对已暂停或底层允许的 failed 实例；运行中的纯磁盘归档、同 ID rebuild、revision 物理删除、请求级私仓凭据明确不支持。旧 OSS 归档也不伪称通过 Cellbox 删除。
- 显式备份不附带远程删除旧归档，避免后续操作盲目重试未知删除。`POST /api/archives/prune` 是用户明确发起的独立清理，按项目保留数执行。
- 新增 `make deploy-cellbox-server`，deploy-all 将成功构建的实际 revision 传给 CoCell。首次 legacy 切换要求隔离数据目录/归档前缀；后续 v2 升级保留原存储。旧部署 target 明确拒绝。
- 只读盘点工具：`kubectl --context CONTEXT -n NAMESPACE get cellboxes.cellbox.local -o json | uv run --no-project python scripts/migration/inventory-cellbox-crs.py`。它只盘 CR，输出 ID、digest、计数和未知项，不读取凭据，也不导入 SQLite、归档索引、HOME、workspace 或 checkpoint。

本次没有实现底层不提供的旧 metadata/archive 通用导入器。旧 importedImage 记录与缺失 revision 的项目会明确显示需迁移，不能自动当成新版 revision 使用。源数据保留和具体恢复路径仍按第 9 节由操作者审查后执行。

## 1. 目标与已确定的边界

CoCell 接入新版 Cellbox 的 template/revision、显式生命周期和单节点 server；同时删减 CoCell 自行叠加的远端资源锁、请求重放和幂等承诺。

已确定的原则：

- 底层不支持幂等，CoCell 就不自动重试有副作用的请求，也不向上层提供幂等语义。
- 底层已有资源锁、BUSY 检查或 generation 校验，CoCell 使用其结果，不再包一套资源排他机制。
- 底层没有保证的并发场景，CoCell 也不通过跨服务长锁、恢复接管或补偿流程承诺更强保证。
- 让用户看到真实状态、错误和未知结果，由用户决定下一步。
- 操作 ID、Sandbox ID 和日志用于关联、查询与排查，不是重放凭证或去重协议。
- CoCell 自己的内存同步、数据库短事务只保护本地记录；不跨远程请求持有，不暗示数据库与 Cellbox 的跨服务原子性。
- 不提供通用的项目级大锁：查看、修改、创建、归档、删除和 Sandbox 操作不统一套项目锁，也不新增同类包装来替代旧锁。
- “本周项目每周只能一个”暂不加锁、不提供并发唯一保证；本次也不改用唯一索引、预约记录等机制补齐该保证。

本次不以增加 Cellbox 幂等接口、请求去重协议或分布式事务为实施前提。底层不支持的能力直接呈现为不支持，不能用隐藏重试或隐式替代行为补齐。

## 2. 新旧契约与当前断点

| 范围 | CoCell 当前使用方式 | 新版 Cellbox | 适配结论 |
| --- | --- | --- | --- |
| 创建 Sandbox | `profileId + importedImageId?` | `templateId` 与 `revisionId` 必须且只能传一个 | 修改请求和项目版本引用；profile 不能直接当作 template |
| 恢复归档 | `profileId + archiveId + importedImageId?` | `templateId/revisionId + archiveId` | 同样使用版本选择器，继续遵守归档兼容校验 |
| 镜像导入、查询、删除 | `/v1/images*` | 已删除；改为 template/revision/build operation | 重写镜像管理适配，不能只替换 URL |
| 预热默认镜像 | `/v1/profiles/{id}/warm-default` | 已删除；按 revision 的 `warmSlots` 管理 | 删除启动同步 warm-default 和默认镜像回滚链 |
| 自动确保运行 | `:ensure-running` | 已删除 | 查询与显式 resume 分开，不再提供自动修复式 ensure 语义 |
| 原地修复、重建 | `:reconcile`、`:rebuild` | 已删除 | 显示能力差异；新建替换作为独立操作 |
| 归档 | 可提交 `{diskOnly:true}` | 请求不接受该字段；仅支持 suspended/failed 来源 | 不能删除参数后假装保持原行为 |
| 资源 lease、域名 route | lease CRUD、`POST /v1/routes` | 已删除 | 删除对应包装，不在 CoCell 重建一套 |
| 直接服务代理 | `/v1/boxes/{id}/services/{port}/` | 保留，包含 HTTP/WebSocket 的活跃访问检查 | 复用已有路径 |
| 幂等 key | 持久化 key，重提时沿用 | `Idempotency-Key` 不参与处理，`ownerKey` 不唯一 | 删除重放与去重含义 |
| 部署 | API Deployment + controller DaemonSet，两套镜像 | 单节点 `cellbox-server` Deployment，一套镜像 | 重写发布入口和 CI |
| 元数据 | 旧元数据账本、本地旧格式等 | 单一数据目录内的 `cellbox.db` | 存量迁移单独实施，无自动转换 |

新版严格拒绝未知 JSON 字段，当前 create/restore 的 `profileId/importedImageId` 会导致 400。当前 CoCell 启动时执行 `ImageCatalog.init()`，随后同步已删除的 warm-default；直接切换 API 地址会出现启动失败。

依据：[当前 client](../../packages/sandbox/src/providers/cellbox/client.ts)、[当前镜像初始化](../../backend/images/service.ts)、[新版请求与路由](../../../cell-box/internal/service/http.go)、[新版创建和生命周期](../../../cell-box/internal/service/service.go)、[新版 catalog 路由](../../../cell-box/internal/catalog/http.go)。

## 3. 数据与职责划分

### 3.1 profile、template、revision、项目

| 对象 | 所属层 | 职责 |
| --- | --- | --- |
| profile | Cellbox 运行配置 | provider、节点、工作目录、身份、资源规格和工具能力；用于构建 revision 与运行能力检查 |
| template | Cellbox catalog | 模板族、描述、默认预热数量和 stable 指针 |
| revision | Cellbox catalog | 成功构建的版本，固定镜像 digest、构建输入和运行配置 |
| 项目与会话 | CoCell | 分类、权限、业务配置、会话关联、选定的 revision 和实际 Sandbox 绑定 |
| 全局默认选择 | CoCell | 新项目默认使用的明确版本；与 template 的 stable、revision 的预热配置分别表达 |
| Sandbox、operation、archive | Cellbox | 实际实例与底层任务、归档内容和归档元数据 |

现有“镜像仓库 → 镜像版本 → 项目选择”的产品入口可以保留，但后端分别映射为 template、revision、项目固定版本。构建状态和镜像身份从 Cellbox 读取，CoCell 不再维护一套独立的导入镜像真相。

建议项目版本引用保留现有业务显示信息，增加 `templateId/revisionId`，逐步淘汰 `importedImageId`。Sandbox 和归档引用也保留实际返回的 template/revision、镜像身份，不从当前 stable 反推历史版本。

### 3.2 默认值和预热分开

- CoCell 的全局默认选择指向明确 revision；创建项目后固定该 revision，不随 stable 漂移。
- 如果产品允许“使用模板当前 stable”，应先解析并展示版本，最终保存实际创建返回的 revision；不能承诺解析到创建之间 stable 不会改变。
- 系统基础镜像也需要建立 template/revision，删除“只凭 profile 创建”的特殊路径。
- 构建成功不自动切换 stable。修改 CoCell 默认选择，不隐式修改 stable 或 warmSlots，不做跨系统回滚补偿。
- revision 的预热配置独立提交和展示。切 stable 不自动清空旧 revision 的 warmSlots。
- 预热观察保留 `stale/observedAt/observedGeneration`；缺失或未知不能显示为 0。`syncStatus=applied` 不等于 readySlots 已满足，也不等于业务就绪。

依据：[新版 catalog 模型](../../../cell-box/internal/catalog/model.go)、[新版模板与预热语义](../../../cell-box/doc/cellbox-usage.md)、[预热观察结构](../../../cell-box/internal/service/template_runtime.go)、[当前项目版本协议](../../protocol/image-types.ts)。

### 3.3 前端项目操作与锁的边界

按实际功能决定数据访问方式，不先提供一个通用锁再让所有操作接入。下表列出当前项目 API；其中部分是后端保留入口，不代表前端当前均有按钮。

| 功能 | 当前入口 | 目标处理 |
| --- | --- | --- |
| 查看项目列表、详情和备份版本 | `GET /api/projects`、`GET /api/projects/:id` | 直接读取项目记录和底层观察；不申请项目锁，不等待维护任务结束才允许查看 |
| 等待操作结果 | `GET /api/projects/:id?waitForOperation=...` | 有界等待或轮询已有操作；不占项目锁，不触发重放 |
| 创建项目 | `POST /api/projects` | 项目记录写入与 Sandbox 创建分步处理；不使用所有新项目共用的创建锁，也不预占镜像 |
| 修改名称、需求链接和备份保留数 | `PATCH /api/projects/:id` | 自有字段原子更新或短事务；不因 Sandbox 正在维护而统一拒绝普通信息编辑 |
| 标记完成、恢复使用中 | 同一 PATCH 入口的 status 字段 | 校验业务状态并更新本地记录；不持有远端资源锁 |
| 查看、修改工具角色 | `GET/PUT /api/projects/:id/tool-role` | 读取或更新角色关联；权限校验与数据写入独立处理，不套项目大锁 |
| 进入项目 | `POST /api/projects/:id/open` | 只读返回；继续运行必须由用户明确调用 resume，不由进入页面触发 |
| 恢复运行、暂停 | `POST /api/projects/:id/sandbox/resume`、`checkpoint` | 使用项目绑定的 Box ID 各提交一次 provider resume/pause，再记录操作结果；不预查状态、不做 App Server readiness 或环境准备、不改写 Sandbox 绑定，底层冲突与未知结果照实展示 |
| 创建、重建或从备份恢复环境 | `POST /api/projects/:id/sandbox/rebuild` | 按实际支持的动作拆分；远端提交交 Cellbox，项目绑定只在本地短事务中更新 |
| 归档项目 | `POST /api/projects/:id/archive` | 可从已暂停/failed 的资源生成备份，或明确复用已有备份；项目状态更新和清理分别记录结果，不把多步流程包进长锁、不承诺整体原子 |
| 文件读取、下载和服务预览 | files、preview、service 路径 | 不加项目级锁；本地只管理自身连接，实际访问与生命周期冲突交给 Cellbox |
| 删除项目 | `DELETE /api/projects/:id` | 清理环境、会话和项目记录分步处理；本地数据删除用数据库事务，不跨远端清理持锁 |
| 独立备份、保留的旧操作入口 | `POST /api/projects/:id/backup`、`sandbox/refresh-runtime` | backup 是用户明确提交的独立操作，仅接受 paused/failed Sandbox；running 返回 409。Cellbox 仍可能返回 BUSY；CoCell 不加资源锁、不自动重试，也不承诺幂等。`refresh-runtime` 按实际能力拒绝 |

当前普通 GET 列表/详情不通过 `projectMutation` 的项目级分布式锁，但详情刷新仍经过本地缓存队列。实现时保持查询与操作分离，普通查看返回当前可用信息，不用维护、删除中等进程内标记替代真实数据查询；数据库已不存在时正常返回不存在。

当前创建入口外包 `projectMutation('project-create', ...)`，直到 Sandbox 创建准备完成才返回，因此不同项目也可能相互等待。这层全局创建锁明确删除，不改成按项目、按周或按镜像的另一种长锁。

组合操作允许部分成功、部分失败，按步骤记录并展示。更新项目绑定或状态时只防止本地记录被无条件覆盖，不承诺数据库与远端操作一起提交；某步未知时不自动继续依赖步骤或执行补偿。

依据：[项目路由](../../backend/projects/routes.ts)、[前端项目调用](../../fe/features/projects/useProjects.ts)、[项目读取与创建实现](../../backend/sessions/manager.ts)、[工具角色入口](../../backend/secrets/routes.ts)。

## 4. 请求、等待、错误与用户决策

### 4.1 有副作用的请求只提交一次

创建、构建、命令、暂停、恢复、激活、归档和销毁均遵守：单个副作用步骤只提交一次，不因超时、连接中断、API 重启或执行实例失联而自动重新提交。一个明确的多步骤业务动作可以调用不同接口，但每步分别记录结果，不整体重跑；某步结果未知时停止后续依赖该结果的步骤。

收到 operation 后可以查询已有 operation；未收到 operation ID 时保留“提交结果未知”。普通日志可以记录本地请求 ID、请求类型、目标资源和时间，但不建设自动接管、自动重放的任务账本。

用户选择“再次提交”是一个新动作、新请求，可能产生新资源或再次执行命令。界面不再使用“原样重试确认结果”“保证不重复创建”等文字。

只读 GET 查询可以在明确期限内轮询；查询失败直接显示读取错误，结束等待后也不触发写请求。

### 4.2 展示事实，不混淆提交、底层任务和本地等待

| 收到的信息 | 应展示的结果 | 不能推断的结果 |
| --- | --- | --- |
| 收到明确拒绝，如 BUSY、CONFLICT、STALE_GENERATION | 错误码、脱敏消息和可用的目标信息 | CoCell 会替用户排队，稍后自动成功 |
| operation 返回 queued/running | 原始 operation 状态和 ID | 业务进程已经健康 |
| operation 返回 succeeded | 底层操作完成；业务就绪检查单独展示 | 所有后续业务初始化也已完成 |
| operation 返回 failed，错误为 UNKNOWN_OUTCOME | 任务报告失败，同时说明执行结果无法确认 | 业务副作用一定没有发生 |
| 提交后没有收到有效响应 | 提交结果未知；允许查询和用户再次提交 | 没有受理，或可以安全重放 |
| 查询已有 operation 的本地等待超时 | 等待超时，保留最后观察到的底层状态与时间 | operation 已失败或已被取消 |
| API 重启，只有本地未完成标记 | 本地记录未确认；查询底层已有 ID，无法查询时保持未知 | 接管旧任务并重新执行能保持幂等 |

需要在协议中分开“底层状态”和“本地提交/查询结果”。当前 `ProjectSandboxOperation.status` 只有 running/failed/succeeded，不能继续把未知结果压成 failed；应允许表达 unknown，或者增加独立的提交结果字段。最终字段形式在实现时确定，不建立额外的自动恢复状态机。

展示 `code/message/operationId/boxId/observedAt` 等已有信息即可。错误正文脱敏后展示，不统一改写成“操作失败，请重试”。当前 Sandbox 为 running 只能说明观察到运行态，不能证明一次响应丢失的命令执行成功。

依据：[当前错误映射](../../packages/sandbox/src/providers/cellbox/client.ts)、[当前项目操作协议](../../protocol/types.ts)、[当前追加消息未知结果处理](../../backend/sessions/manager.ts)。追加消息路径已经采用“接收状态不确定，不自动重发”的处理方式，可复用这一边界。

## 5. 锁与协调机制的删减

新版 Cellbox 已有 per-Box admission 锁、存储事务、进行中的 operation 检查、活跃执行和 HTTP/WebSocket 访问检查，以及 generation 校验。CoCell 不重复实现这些远端资源保护。底层各接口的保护范围并不完全相同，也不代表任意多步业务流程整体互斥。

### 5.1 当前机制与目标

| 当前机制 | 当前保护范围 | 本次目标 |
| --- | --- | --- |
| `project-control:project-create` | 所有新项目共用，从创建记录覆盖到 Sandbox 准备结束 | 明确删除，不用通用大锁串行化不同项目，也不以本周项目规则为由保留 |
| `project-control:<id>` | 多实例项目操作准入和状态修改，部分路径覆盖远端调用 | 拆分远端操作与本地数据修改；移除资源级包装，自己的记录更新使用短事务 |
| `project-maintenance:<id>` | 生命周期与备份全流程长租约 | 删除跨远程请求的维护长租约，不承诺多步流程独占 |
| `api-instance:<id>` 与 resume owner | 实例存活判断、恢复任务接管 | 删除用于接管并重放 Sandbox 操作的机制；其他用途独立核对 |
| `managed-image-catalog` 与 ImageCatalog 全局队列 | 镜像列表、状态、构建和默认值变更串行化 | Cellbox catalog 直接读取与提交；只保留 CoCell 自有分类等字段的短更新 |
| `image-reservation:<digest>`、本地 reservations | 选镜像到项目引用落库之间预占，阻止删除 | 删除跨系统预占，不承诺选择、远端创建、本地绑定整体原子 |
| 全局 pending build 检查 | 一个构建或未知导入阻止其他镜像同步 | 删除 CoCell 全局阻塞，交给底层构建队列和实际响应 |
| `acquireUsage`、远端 lease 与 keepAlive | 额外请求旧 Cellbox lease，定期续租 | 删除接口及续租；不在 CoCell 补实现替代 lease |
| SandboxManager 本地锁、usage 与 single-flight | 句柄、引用计数、观察缓存，以及部分恢复/忙碌控制 | 缩到本地内存一致性；不合并有副作用的请求来提供去重，不把缓存状态当远端互斥依据 |
| prepare 队列、read-drain、连接阻挡 | 本地配置准备与连接生命周期，也参与多步远端操作 | 保留关闭本进程闲置连接和自身对象清理；移除跨请求排队、阻止其他用户操作等远端保证 |

MySQL named lock 在 `COCELL_MULTI_API=1` 时启用；本地 Promise 队列和 Map 不因此消失。删除协调器调用时要连同失主持有检查、心跳、重入上下文和旧错误文案一起审查，避免保留一条隐式接管路径。

### 5.2 本地记录与其他业务锁

以下内容必须按保护对象拆分，不能把它们误称为 Cellbox 锁，也不能为了删资源锁而破坏普通数据写入：

- MySQL 的 `SELECT ... FOR UPDATE`、提交与回滚只用于 CoCell 自有记录；事务中不调用 Cellbox。
- 本地句柄缓存、引用计数和连接释放的短同步可以保留，不对其他实例或远端资源提供保证。
- `session-control/session-execution` 保护 CoCell 会话记录与任务提交，需另行区分本地记录同步和远端 thread 排他；远端已有 BUSY 就透传，没有也不默认承诺单执行。不能用 Cellbox 不知道会话为理由保留任意长租约。
- schema 初始化、共享文件写入、凭据文件发布等保护 CoCell 自有资源的机制，不因迁移 Cellbox 一刀切删除，也不借本次迁移扩大改造范围。
- 定时任务若保留，只负责既定调度策略；不承担失联写操作的接管、去重或失败重放。

暂停或销毁前可以关闭 CoCell 自己的闲置读取连接，避免本进程占用造成 BUSY；对于仍在使用的连接、其他实例和外部调用，让底层返回真实冲突。关闭自己的连接不构成“暂停前已全局停止所有读取”的保证。

依据：[MySQL 协调器](../../backend/infra/storage/coordination.ts)、[项目锁与接管](../../backend/sessions/manager.ts)、[本地项目维护状态](../../backend/projects/service.ts)、[镜像队列与预占](../../backend/images/service.ts)、[SandboxManager](../../packages/sandbox/src/manager.ts)、[自身数据事务](../../backend/infra/storage/web-state.ts)、[Cellbox admission](../../../cell-box/internal/service/box_transactions.go)、[Cellbox I/O admission](../../../cell-box/internal/service/http.go)、[服务代理](../../../cell-box/internal/service/access.go)。

### 5.3 本周项目暂不保证并发唯一

“每周只能一个本周项目”保留为普通业务检查：已经查询到本周项目时可以提示已存在，但不把这次检查到创建记录之间变成互斥区间。

本次明确不为它新增按周锁、分布式锁、全局创建锁、创建中占用标记、预约记录或数据库唯一约束来保证并发唯一。已有 `creatingWeeklyProjects` 这类创建中占用机制也不作为必须保留的保证，随创建路径简化处理。

并发请求可能都通过存在检查并分别创建项目；如实展示已创建记录和各请求结果，不宣称去重成功，也不自动合并、回滚或删除其中一个。暂不建设重复项目自动修复机制。

这条决定是已确认范围，不再列为本次待补的唯一性设计，也不成为保留或重建通用项目大锁的理由。

## 6. 当前重试、重放和轮询的处理

| 当前路径 | 实际行为 | 本次处理 |
| --- | --- | --- |
| CellboxClient 通用 request | 不自动重发写请求，但错误提示建议复用 key 重试 | 保持单次提交，删除 key、错误字段及重放文案的幂等含义 |
| createJournal | 保存 key/boxId；再次 create 仍 POST，依赖服务端按 key 去重 | 删除去重逻辑；可以保留已确认资源信息用于查询，不再靠重提找回结果 |
| `recoverResume/recoverLocalResumes` | 共享模式在原 owner 的 presence 已释放后接管；单实例模式每秒扫描持久化 running resume，本地无 worker 时用同操作 ID 再调用恢复 | 删除两种自动接管与重新提交；并非 provider 对每个网络错误即时重发 |
| `startResume` 的 UNKNOWN_OUTCOME 分支 | 保留 running intent，等待后续恢复重放 | 改为公开未知结果，不无限等待自动恢复 |
| `resumeSuspended` 的 OPERATION_EXPIRED 分支 | 检查状态后换 key 再提交 resume | 删除旧重试分支 |
| 镜像 retry API | 用户触发，但使用原 key 再提交，并称为确认原请求 | 删除“重放确认”能力；用户明确再次提交时创建新操作 |
| 镜像删除重提 | 未知结果重提复用 cleanup ID/key；已知 failed 后再次提交会生成新 ID/key | 两种都不承诺底层去重；删除同 key 安全重试的解释，按实际能力展示结果 |
| scheduledArchive / retryCleanup | 后续调度再次执行未完成归档和清理 | 不因失败、未知或重启自动重新发送副作用请求；呈现残留资源和清理结果 |
| wait/getOperation | GET 轮询，传输错误后继续查询已有 operation | 可以保留有界等待；不重新提交原操作 |
| App Server readiness | 重连并执行只读就绪探测 | 可以保留明确期限内探测；失败不重新创建、恢复或执行任务 |

正常定时策略与失败重试分开：一次自动暂停政策可以提交一次暂停；结果未知后，不在下一轮扫描把同一目标当作未执行再次提交。需要保留最小结果记录用于展示和避免盲目重做，但它不承担自动执行恢复职责。

用户显式发起新的清理时，先展示目标和最新查询结果，再提交一次支持的操作。不能因用户点击“清理”就宣称上次删除没有执行或本次不会重复。

依据：[provider](../../packages/sandbox/src/providers/cellbox/provider.ts)、[恢复任务](../../backend/projects/sandbox-operations.ts)、[接管与调度](../../backend/sessions/manager.ts)、[镜像重提](../../backend/images/service.ts)、[就绪探测](../../backend/execution/app-server-reader.ts)。

## 7. 生命周期和功能差异

### 7.1 查询、恢复和业务就绪

读取项目、查询 Sandbox、读取文件和获取历史不隐式 resume。用户明确提交 resume 或 checkpoint 时，CoCell 用项目当前绑定的 Box ID 调用 provider.resume 或 provider.pause 一次；不先 GET Box 判断 running/suspended，不按本地 phase 短路，也不因 App Server readiness 或环境准备结果改变是否提交。Cellbox 返回的冲突、BUSY、失败或未知结果写入该项目操作记录并原样呈现；已有 operation 可通过 GET 查询，不重新提交。

这两个动作不重写项目 Sandbox 绑定，不启动 App Server readiness 探测或工作区环境准备。暂停/恢复对底层状态是否适用由 Cellbox 决定；请求冲突透传，不自动换 generation 或重试。

暂停/恢复不包含“修复到 ready”的语义；failed、deleted、staged 或其他状态的行为由 Cellbox 响应决定，CoCell 不自动退化为创建、重建或恢复备份。

`POST /api/projects/:id/sandbox/checkpoint` 只负责暂停并返回暂停结果，不启动后台备份。用户需要工作区备份时，单独调用 `POST /api/projects/:id/backup`；仅 paused/failed Sandbox 可备份，running 返回 409。备份期间底层仍可能返回 BUSY；CoCell 不叠加资源锁、不自动重试写请求，也不向上承诺幂等。Resume 同样呈现底层真实结果。

现场已确认一次 BUSY 的原因：原 Checkpoint 在暂停成功后返回，同时继续提交 archive 操作；用户此时 resume，底层仍在备份，因此第一次收到 BUSY，备份结束后第二次成功。此次移除 Checkpoint 的自动备份，而不是修改 Cellbox 的资源互斥或重试 resume。独立备份保留进度、耗时、成功/失败/未知结果；只有用户明确发起备份或归档时才生成磁盘归档。

### 7.2 纯磁盘归档

新版 capture 不自动暂停，且不支持 diskOnly。普通 capture 要求 suspended 或 failed、持久 HOME 布局、节点支持和 S3 配置；failed 仍由 provider 验证可安全读取，不代表任意失败实例都能归档。归档可以从已暂停/failed 的资源生成备份，也可以由用户明确选择复用已有备份。

running Sandbox 的“停止写入后只归档磁盘”仍不可用；归档不能隐式执行 Checkpoint。需要备份时先明确暂停，再单独备份或归档。

已暂停的实例可以由归档操作生成新的 Cellbox 备份，也可以明确复用已有备份；归档是 workspace 文件内容，不等于完整 HOME、rootfs 或进程内存。现有 CoCell 受保护工具 OSS 备份分支是另一条路径，需要独立核对其范围与凭据能力，不能与 Cellbox capture 混为一种保证。

### 7.3 同 ID 重建与新实例替换

新版没有同 ID rebuild/reconcile。现有“同 ID 保留挂载目录重建”入口应显示不可用。

若提供“从归档创建新环境”，它是独立操作：创建 staged 候选、配置凭据和启动信息、激活、验证文件及历史，按用户明确发起的恢复动作切换。候选失败不自动重建；新旧实例、当前项目绑定和清理结果分别展示。

项目绑定切换可以用本地短事务防止覆盖本地记录，但不承诺旧实例关闭、新实例启动和数据库切换整体原子。新环境验证前不自动删除旧环境；切换失败或清理失败显示残留资源，停止隐式补偿和定时重做。

### 7.4 镜像版本删除与私仓认证

新版支持 revision active/retired，目前没有 revision 物理删除接口。“停用版本”“隐藏 CoCell 条目”“释放镜像存储”必须区分，不能用本地标记删除宣称底层空间已回收。退休 stable 前仍按 Cellbox 要求先明确切换或清空 stable。

新版 BuildRequest 没有旧的 registryAuth 字段。部署侧已配置的 registry Secret 可以使用；现有“用户临时输入凭据后导入任意私仓”的路径不能直接保留。第一版显式提示该方式不支持，不把临时凭据隐式写成全局配置。

这些功能差异应先在产品中暴露。将来若单独决定扩展底层能力，再提交独立方案；不是本次适配的隐含承诺。

## 8. 单 server 部署改造

### 8.1 部署入口

新增统一的 `deploy-cellbox-server` 入口，替换 API/controller 分别构建发布的流程：

1. 确认 CELLBOX_SOURCE_DIR 的提交与要迁移的版本一致。
2. 使用 Cellbox 的 `make build` 产物和 `images/cellbox-server.Dockerfile` 构建、发布一个 server 镜像。
3. 发布成功并确认 digest 后，再进入目标环境的 Helm 变更。
4. 设置 `server.image/server.nodeName`、单副本、storage 和完整 profile；检查 server Deployment 的 rollout 与实际镜像 digest。
5. 同步 Sandbox 产品镜像构建，并建立系统 template/revision；只修改 profile.image 不再能提供默认 Sandbox 创建能力。
6. 改造 deploy-all、debug-mount 和集成 CI，最后发布适配后的 CoCell。

`deploy-cellbox-server` 入口已实现，但执行会修改外部环境，须按已审查的目标和配置另行授权。

现有 `deploy-cellbox-local-metadata` 依赖旧布局，不能沿用作 SQLite 迁移入口。旧 API/controller target 应删除或明确拒绝用于新版，不能保留两个名称却重复执行同一次 server 升级。

### 8.2 配置与存储

| 配置或资源 | 新版要求 |
| --- | --- |
| `server.nodeName` | server 固定到配置的运行节点，与 Kubernetes profile 节点一致 |
| `api.replicas` | 1；server 已有自身活动实例选主，CoCell 不另外补选主 |
| release/profile namespace | 与新版 Chart 校验一致 |
| `server.image` | 使用已发布并验证的镜像 digest |
| `storage.hostPath` 或 `storage.existingClaim` | 持久化 SQLite 和构建日志；不是 CoCell web 自己的数据卷 |
| `api.config.dataDir` | 容器路径固定为 `/var/lib/cellbox-data` |
| `/var/lib/cellbox` | 节点运行数据、checkpoint 和 HOME 所在的另一类存储，不能与 SQLite 目录混淆 |
| objectStorage | 归档内容存储；无配置时显示归档不支持，元数据不回退到对象存储 |
| BuildKit 与 registry Secret | 构建 revision 的条件，凭据保留为本地配置/已有 Secret 引用 |
| API Service | 新版仍保留 `cellbox-api` Service 名称，但 Deployment 已变成 cellbox-server |

单 server 需要访问宿主机 CRI 等运行资源，不能直接沿用旧普通 API Pod 的挂载和权限配置。采用新版 Chart，完整核对旧安装 values，不盲目 `--reuse-values`。升级中删除的旧资源也要列入预览。

实际源码路径必须由 deploy.env 或显式参数重新确认，不记录本机旧 worktree 的绝对路径为公共部署默认值。本文不包含安装地址、凭据正文或部署授权。

依据：[现有部署 helper](../../deploy/scripts/k8s/cellbox_deploy.py)、[现有 Makefile](../../Makefile)、[Sandbox 镜像部署](../../deploy/scripts/cellbox/build-deploy-cocell-image.sh)、[集成 CI](../../scripts/integration/ci/deploy.mjs)、[新版 Chart](../../../cell-box/charts/cellbox/templates/api.yaml)、[新版部署指南](../../../cell-box/doc/deployment.md)。

## 9. 存量数据迁移

### 9.1 已知限制

- 新版 OpenStore 遇到旧 `state.json/catalog.db` 会拒绝启动；旧元数据账本没有自动转换路径。
- 旧对象存储的归档内容存在，不等于新版 SQLite 内存在对应归档元数据。
- 新版公开 API 没有旧归档元数据或原始 archive payload 的通用导入接口。不能把旧 archive ID 直接交给全新的 server 就认为可恢复。
- Kubernetes CR 可以出现在 runtime inventory 中，但单 Box 读取和操作依赖服务自己的持久记录。能列出旧 CR，不等于旧 Box、profile 快照、operation 或 archive 已迁移。
- 镜像源 tag 相同不代表最终构建 digest 相同。重新构建会注入 Guest/产品内容，不能据此自动匹配旧版本或绕过归档兼容性。
- 同节点 checkpoint 不是可跨新安装直接恢复的便携备份，内存和进程连续性不能默认保留。

依据：[OpenStore](../../../cell-box/internal/service/store.go)、[Box 持久记录读取](../../../cell-box/internal/service/service.go)、[runtime inventory](../../../cell-box/internal/service/inventory.go)、[公开 HTTP 路由](../../../cell-box/internal/service/http.go)。

### 9.2 迁移清单

先生成只读盘点，按对象记录来源、目标、映射状态与未知项，不自动修改旧环境：

| 对象 | 需要保留或核对的内容 | 目标处理 |
| --- | --- | --- |
| CoCell 项目、会话、权限、模型配置 | 自有数据库与文件、项目当前绑定、会话线程标识 | 保留原数据，版本引用做显式映射 |
| 旧镜像与导入结果 | 原始来源、成品 digest、构建命令、运行配置、profile、工具能力 | 建立 template/revision；不能只按名称或 tag 自动匹配 |
| 旧 Sandbox | 实例 ID、节点、CR、HOME、workspace、当前状态与项目归属 | 选择继续保留旧环境或创建新实例；不自动接管旧 CR |
| 旧归档 | 元数据、payload 位置、大小、校验、image/agent、线程关联与 portable 属性 | 确认导入工具或文件恢复路径；缺一项时显示未完成 |
| checkpoint | 节点、Box/generation、内存和文件位置 | 单独判断可用性；不能作为默认跨版本迁移方式 |
| operation/exec 历史 | 已知 ID、状态、结果不确定项 | 可作为只读历史保留；不恢复执行队列、不重放任务 |
| 凭据与共享配置 | 原生文件来源、挂载和授权关系 | 按现有凭据机制重新配置，正文不进入迁移报告 |

### 9.3 两阶段执行

第一阶段用独立 namespace、独立 server 数据目录、独立归档对象前缀和独立 CoCell 测试数据验证新建链路，保留旧安装。测试实例不与旧实例同时写同一个 HOME 或同一份运行资源，也不让测试清理操作作用于旧归档。此阶段验证新版本能力，不宣称用户存量已迁移。

第二阶段再针对已盘点对象选择迁移方式：

- 从旧环境导出可验证的 workspace 文件，恢复到新版新实例；明确不保留进程状态，并验证 CoCell 历史实际依赖的文件是否全部包含。
- 对已有 CoCell OSS 归档，先验证受保护恢复工具、文件布局与目标版本，再决定是否沿用该路径；不能泛化到所有 Cellbox archive。
- 如果要保留原 Cellbox 归档索引、版本快照和存量 Box 元数据，需要单独实现并 review 显式导出/转换/导入工具。当前没有该工具，不提供直接写 SQLite 内部记录的临时命令。
- 无法映射或验证的对象留在旧环境并展示原因，交由用户选择后续动作，不猜测补齐，不填 0 或改成迁移成功。

迁移结果至少记录：原项目、原 Sandbox、新 template/revision、新 Sandbox、文件/归档校验、历史验证、未迁移项、旧环境保留位置与切换状态。

### 9.4 切换与回退

明确切换窗口和写入目标，完成验证后再修改项目绑定或服务流量。先做数据库及各存储的一致备份；SQLite 使用支持的一致备份方式，不能运行中只复制 cellbox.db 而遗漏 WAL。

CoCell 与 Cellbox 版本需要成对切换。新版本产生写入后，不能只把 API 地址指回旧服务就称为回退完成；应列出新增项目、版本、归档和绑定变更，再由用户选择保留、导出或回退的数据范围。

旧安装、旧持久目录和旧归档在迁移验收与保留策略确认前不删除。回退、清理和实际部署分别是明确的操作，不由未知错误触发自动执行。

## 10. 代码范围与实施顺序

| 阶段 | 主要文件或模块 | 完成条件 |
| --- | --- | --- |
| 1. 新契约与版本模型 | packages/sandbox 的 Cellbox client/provider；protocol/image-types、sandbox-types、remote-archive-types；backend/images | 支持 template/revision/build；系统默认版本明确；不再调用旧 images/warm-default |
| 2. 请求与状态展示 | backend/projects/sandbox-operations、sessions/manager、execution/container-runtime；protocol/types；fe/lib/api 和项目/镜像页面 | 单次提交、保留底层错误、可表达未知；再次提交是新操作 |
| 3. 锁与恢复简化 | SharedCoordinator 各调用点、ProjectService、SandboxManager、ImageCatalog、cellbox-runtime | 删除通用项目大锁、全局创建锁、远端长租约、接管重放、镜像预占与全局构建阻塞；本周项目不补并发唯一保证；本地数据写入不受破坏 |
| 4. 生命周期与能力差异 | 项目操作、归档、runtime config、镜像版本 UI | 显式恢复；就绪分开；纯磁盘归档、同 ID 重建、物理删除和私仓能力如实呈现 |
| 5. 部署与 CI | Makefile、deploy/scripts、deploy.env.example、scripts/integration/ci | 构建发布单 server；系统 template/revision bootstrap；渲染和实际部署检查覆盖新布局 |
| 6. 存量迁移 | 独立盘点与转换工具、迁移结果报告 | 明确映射、校验与残留项；逐项确认迁移，不重放历史操作 |

阶段划分用于 review，不要求把所有内容塞进一个不可审查的大改动。代码从最新 master 建立 feature 分支，功能修改不在共享部署分支上直接提交；实际部署仅在用户明确要求时执行。

文档和测试里的旧幂等、去重、维护锁要求也要同步修正，尤其是当前集成指南的“并发进入去重”和“原 key 重试”相关断言。本次已同步集成指南与测试断言；部署后的实测结果见第 12 节。

## 11. 验收

### 11.1 高价值协议和错误用例

- 对每类有副作用请求，模拟连接中断、响应丢失或无效响应，验证一次动作只发出一次提交，结果为未知且无隐藏 fallback。
- 已取得 operation ID 时只查询该 ID；本地等待超时不重发、不把底层 operation 改成失败。
- 服务重启、owner 失联或重新进入项目，不自动重放 create/resume/exec/archive/destroy/build。
- 用户再次提交产生独立请求，界面和协议不宣称安全重放；取消本地等待不宣称底层操作已取消。
- 底层返回 BUSY、CONFLICT、STALE_GENERATION 时保留分类，不自动排队、换 key 或换 generation 再提交。
- 并发测试允许底层冲突和实际创建多个资源，不再断言 CoCell 对所有重复调用实现全局去重；自身项目记录不能被无条件覆盖，残留资源可见。
- 查看项目不申请项目锁，也不因维护任务而等待或拒绝；不同项目创建不被全局创建锁串行化。
- 本周项目不以“并发创建最终只能一条”为验收条件，不添加按周锁或唯一约束来让该断言通过；并发产生多条时正常展示，既有记录的普通存在检查与此分开验证。
- 保留本地数据库事务和句柄释放的必要回归，不为已删除的长锁结构写实现镜像测试。

### 11.2 产品与真实链路

- 系统模板、仓库模板和 revision 构建、查询、选择、默认值与预热信息可用；未知数量和过期观察正确显示。
- 新项目固定 revision；stable 改变不替换已有实例；再次同步同一 tag 可以形成新 revision，不假定它与旧结果相同。
- GET 和历史读取不唤醒实例；显式 pause/resume 各发出一次 provider 生命周期调用，记录真实 operation 结果；不做状态预查、App Server readiness、环境准备或项目 Sandbox 绑定重写，底层冲突不重试。
- HTTP/WebSocket、文件、工具凭据和会话历史通过新实例验证；冲突直接呈现，测试不得靠无条件重试通过。
- 归档前置条件、portable/image/agent 校验、staged 恢复与显式激活可用；不支持的入口明确显示不支持。
- 文件恢复、会话历史验证与新旧绑定切换分别有结果；失败候选、清理残留和旧备份没有被静默删除。
- 私仓只验证当前明确支持的凭据方式；模板退休和物理空间回收不混淆。

### 11.3 构建与部署验证

实现完成后运行 `pnpm typecheck`、`pnpm build`、受影响的高价值单元测试和 `pnpm test:integration`。runtime 改造再对明确的测试安装运行 `pnpm test:integration:live`；文件、进程连续性、归档恢复与历史按范围运行 `pnpm test:integration:full`，它会消耗真实模型 token。

部署侧先完成 Helm 渲染检查，确认旧 API/controller 资源变更、单 server、节点、storage、Secret 引用和 CRD。实际部署后验证 server digest、SQLite 重启持久性、新建与生命周期链路，以及存量映射结果；构建通过不能代替这些检查。不创建临时工具 Pod。

旧安装保留、测试资源归属和清理结果写入验收报告。清理请求结果未知时记录残留并停止自动重提，不能为让测试看起来干净而违反单次提交原则。

现有测试入口见 [集成测试指南](integration-tests.md)。指南已改为只读进入、明确恢复、冲突透传和未知结果不重放；本次验证与历史实测分别记录。

## 12. 实施与验收结果

1. 本地请求 ID 只作展示和日志关联；Cellbox operation ID 保留在实际资源观察中。写请求传输丢失/等待超时显示 unknown，GET 轮询不会重新提交动作。
2. 系统 template/revision bootstrap 已实现；CoCell 默认选择与 Cellbox stable/warmSlots 分开。旧 importedImageId 未映射为 revision 时阻止创建/恢复并显示需迁移，不按名称或 tag 自动映射。
3. 自有记录短事务、连接引用计数、只读连接缓存保留。native turn 的协调和已接受 turn 观察保留，不重新发送 turn；没有把 session 锁包装成项目或 Cellbox 资源大锁。
4. 第一版明确不支持运行中的纯磁盘归档、同 ID 重建、原地 refresh、revision 物理删除和请求级私仓构建凭据。未来恢复这些能力需独立实现，不能隐式替代。
5. 尚未执行存量迁移，也未建设底层不提供的旧 metadata/archive 通用转换器。文件恢复、已有 OSS 备份路径或独立转换工具，需要按对象盘点后由操作者选择。
6. 已按用户确认切换主安装，使用独立的新元数据目录和对象存储前缀，保留旧目录、旧前缀及配置、元数据备份。未执行旧数据导入；旧数据保留期和具体迁移、回退操作尚未实施。真实模型 full 和专项用例仍需另行验收。

实现阶段本地验证：后端、Sandbox SDK/provider 和 util 单测 379 项通过；`pnpm typecheck`、`pnpm build` 通过。构建保留原有 bundle 体积提示。部署 helper 的 Python/Shell/JavaScript 静态检查及 Helm lint/render 通过，双 selector 和空 selector 均拒绝。桌面 UI 28/28、手机 UI 28/28 通过。完整集成运行 66/67 通过，唯一 harness 失败发生在测试文件并行编辑窗口，补齐导入后定向复验 1/1 通过；本地套件无跳过或 flaky。完整报告位于 `tmp/integration/2026-10-18T04-46-31-132Z-f2cd44a0`，定向报告位于 `tmp/integration/2026-10-18T04-48-46-317Z-d1e27128`，报告未提交。

部署结果（2026-10-18）：CoCell 应用提交 `55e563c1`，Cellbox 提交 `6465c3e`。服务器和两个 Web 副本均就绪，运行镜像 digest 已与 registry 核对，公网健康检查 HTTP 200。发布过程中补齐旧 registry/initImage 配置保留、移除废弃 publicUrl，以及 revision 显式 launcher 命令；相关 Python 测试 3 项通过。

现场验收 `pnpm test:integration:live` 最终 3 项通过、3 项专项未启用：覆盖浏览器只读进入与显式恢复、两个项目并发恢复，以及真实文件归档、恢复到新 Sandbox、再次归档和删除。现场发现并修正历史归档来源被重复列入删除的问题；Box 查询返回 NOT_FOUND 时原样返回，不再追加 purge。修正前先复现失败用例，修正后相关运行时单测 103 项、类型检查和构建通过。现场报告为 `tmp/integration/2026-10-18T06-36-14-834Z-0a9cb819`，报告未提交。

首次冷启动曾因节点拉取约 1 GB 镜像耗时 3 分 8 秒，超过底层启动时限而失败；发布验收应先确认制品已进入运行节点的镜像缓存。失败测试资源经查询确认后单独清理，没有自动重放创建请求。同期短暂连通性异常自行恢复，原因未确定。最终核对原有 75 个项目、188 个会话及 28 个旧 CR 的 UID、状态全部保留，测试新增项目和 CR 已清理；266 条旧归档仍待迁移。

Checkpoint 与备份拆分补充验收（2026-10-18）：应用已更新为 `cf30a956`（主实现 `7188c4a4`）。Checkpoint 只暂停；独立备份通过 `/api/projects/:id/backup` 提交。修正并发 resume 收到 BUSY 后导致备份误报本地操作记录冲突的问题；备份结果与请求耗时按各自 operation ID 记录，不覆盖后续请求的操作结果。相关用例先在旧实现复现失败，修正后后端/SDK/util 单测 385 项、组件测试 7 项、本地 harness/桌面/手机 70 项全部通过，类型检查和构建通过。

本次现场回归 3 项通过、3 项工具/预热池专项未启用，无失败、无自动重试。覆盖 Checkpoint 后立即提交首次 resume、显式备份、真实文件归档恢复及后续清理；报告为 `tmp/integration/2026-10-18T07-50-27-786Z-87a83c1a`。两个 Web 副本的镜像 digest 已核对，公网健康检查 HTTP 200；部署前记录的 76 个项目、189 个会话及 28 个旧 CR 均核对保留，4 个测试项目已删除，没有新增测试 CR 残留。Cellbox 服务未更新，测试安装未操作。

第 1 节边界不变：不补幂等、不自动重放有副作用的请求、不提供通用项目大锁、不叠加远端资源强锁；本周项目暂不加锁、不补并发唯一保证，向用户呈现真实结果。
