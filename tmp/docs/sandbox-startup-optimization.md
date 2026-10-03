# Sandbox 启动优化总结与 Cellbox 状态存储设计

日期：2026-10-03。范围：CoCell 与 Cellbox 的 Kubernetes Sandbox 新建、恢复与就绪验证。

本次提交包含已经实现并部署验证的启动优化。本文后半部分记录后续状态存储设计；尚未实施数据迁移、历史清理或聚合账本替换。

## 1. 结果与测量边界

优化前的一次新建耗时 54.665 秒，一次 restore 耗时 50.058 秒。它们是早期单次基线，不能与最终的小样本比较推导总体分位数。

最终版本采用兼容旧 API 的普通 JSON 元数据写入格式，结果如下：

| 操作 | 样本 | 服务端耗时 | 中位数 |
| --- | --- | --- | --- |
| 新建 | 5 次 | 4.226、4.219、4.182、4.452、5.000 秒 | 4.226 秒 |
| restore | 2 次 | 6.555、6.676 秒 | 6.616 秒 |

服务端耗时从 CoCell 记录操作开始计至操作终态；不包含此前客户端到服务端的请求传输和之后 UI 展示延迟。客户端采样存在额外观察误差，五次新建的观察耗时为 4.278、4.263、4.275、4.647、5.052 秒。

测试通过正常项目 API 创建实际 Sandbox；restore 两次均验证了工作目录中的标记文件内容。没有创建临时诊断 Pod。样本来自已有镜像缓存和挂载配置的同一测试环境，不能承诺冷拉取镜像、集群拥塞或跨节点时也满足这个耗时。

结论：本轮新建样本达到或接近 5 秒；restore 尚未达到 5 秒。没有足够样本宣称稳定的 P95/P99，也没有实现 1 秒启动。

## 2. 已实现的优化

### 2.1 共享目录与启动配置

- CoCell 一次发布共享 AGENTS.md、docs 和 App Server 启动配置；Sandbox 通过只读目录挂载直接读取。
- Launcher 在 Sandbox 内创建本地私有运行目录，将共享文档链接到 Codex Home，以 agent 身份启动 Codex App Server。
- 挂载配置集中在 JSON 文件中，包含 `sharedDirectory.enabled`、`hostPath` 和 `nodeName`。示例见 `deploy/mounts.example.json`，通过 `COCELL_MOUNTS_CONFIG` 指定。
- Helm 为 CoCell 配置目录挂载和节点选择；Cellbox Profile、CRD 和 Controller 支持 `sharedReadOnlyHostPath`。
- 开关与 Sandbox 的 `sharedDirectory` capability 同时满足时才走挂载路径；旧 Sandbox 保留远程初始化与文件同步回退。

挂载优化取消了每个新 Sandbox 的共享文档复制和启动配置远程传输，但仍需本地目录初始化和真实就绪验证。API Key、API 地址随启动配置发布，属于操作员明确启用的共享配置。

目前是同节点 hostPath 方案：CoCell 与对应 Sandbox 必须使用同一个节点、同一个预先准备的宿主机目录。它不是跨节点共享文件系统。共享配置由 Launcher 启动时读取；更新文件不会自动重启已经运行的 App Server。共享文档则直接从目录读取。

### 2.2 凭证按需交付和批量确认

- 普通启动只交付 `cocell_tool_runtime`；OSS 凭证延迟到归档备份或恢复实际需要时交付。
- 增加 API 和 Guest 批量凭证接口，携带 expectedGeneration，在完整校验后写入声明过的 slot。
- 批量成功后一次确认各 slot 的摘要；失败或 generation 变化不确认，重试完整的未确认批次。
- 旧 Guest 不支持批量接口时回退至单 slot 交付；connect/reconcile 保留已有 generation 的文件快照语义。

批量写入是每个文件独立原子替换，不是所有文件组成一个原子事务。中途失败可以留下部分新文件；调用方通过完整重试和成功后确认处理这一点。

### 2.3 内部 App Server 通道

- CoCell 后端连接 App Server 使用带 API 身份认证的内部 HTTP/WebSocket 通道。
- 内部连接不再创建浏览器 Route/Grant，不需要 Grant 续期和撤销的账本事务。
- 浏览器预览仍使用原有授权机制；旧 API capability 缺失时保留回退。
- 内部通道校验资源归属、运行实例和服务端口，持有流访问约束，防止连接期间暂停或删除资源。

### 2.4 减少重复检查和无效租约

- 已挂载的标准工作目录初始化无需再执行远程目录准备命令；自定义子目录仍做路径和所有权检查。
- 就绪验证保留真实 WebSocket initialize RPC，删除额外的 thread/list 请求。
- 已挂载的标准工作目录初始化跳过空的远程租约事务；执行、自定义目录和旧初始化路径仍使用租约。
- root debug 读取归档时不再递归 chmod 工作区；Guest 的 root debug 写工具跳过向 debug 的临时所有权转移，结束时仍恢复 agent 所有权。
- agent 必须保持非 root；明确配置 debug UID/GID 为 0 才启用 root debug，旧非 root 配置继续支持。

### 2.5 Kubernetes 连接与探测

- Guest Token 按 CR、Pod 和容器运行身份缓存，合并同一身份的并发读取；容器重启和资源替换后失效。
- 连接解析合并重复运行状态检查，保留实例身份校验。
- Kubernetes 客户端未显式配置时使用 QPS 50、Burst 100；保留显式配置。
- Pod readiness 探测周期从 2 秒改为 1 秒。
- Guest healthz 每次尝试限制为 1 秒，在整体启动截止时间内重试，避免 Service 发布延迟导致一次连接阻塞整个启动。

### 2.6 元数据路径

- 仅修改聚合账本的事务跳过两次冗余全账本 GET；仍保留条件写入、pending intent 和恢复流程。涉及独立镜像元数据的事务保留原校验。
- 操作轮询只复制目标 Operation，避免每次 JSON 复制全部历史。
- Sandbox 观察更新只复制目标 Box 和 Boxes 索引，避免深拷贝其他集合。
- Creating/Restoring 阶段不提前发布不可用于 I/O 的实例身份，在 Running 时发布，减少额外 generation 写入。
- 激活状态更新与操作完成合并为一次持久化事务。
- 新写入仍为普通 JSON，旧 API 能读取；读取兼容初期实验产生的 gzip 对象，并限制解压大小。

gzip 写入实验未保留：最终性能数据不采用该实验版本。没有删除事务锁，也没有把未持久化的成功状态提前返回给调用方。

### 2.7 耗时分析工具

- CoCell 记录操作阶段、运行时准备、凭证与恢复耗时；Cellbox 记录接收、创建资源、保存 Handle、等待就绪、healthz 和完成持久化耗时。
- `pnpm sandbox:timing` 只读采集 Kubernetes CR、Pod、Events，并可结合多个服务端 JSONL 文件离线分析。
- 输出只包含诊断字段，不保存 Pod env、argv、完整 CR 注解、凭证或命令输出。

示例：

```sh
pnpm sandbox:timing --context CONTEXT --watch --duration 180 --interval 1 --output tmp/sandbox-timing.json
pnpm sandbox:timing --input tmp/sandbox-timing.json --runtime-log tmp/cocell-timings.jsonl --runtime-log tmp/cellbox-timings.jsonl
```

Events 可能过期，Kubernetes 时间戳与采样存在精度限制。低频旁路采集和服务端阶段日志优先，避免在小节点上密集轮询干扰测试。

## 3. 当前新建阶段与剩余瓶颈

以下是最终版本一次 4.226 秒新建的阶段分解：

| 阶段 | 耗时 | 做了什么 |
| --- | --- | --- |
| CoCell 起始阶段 | 11 ms | 操作阶段推进 |
| Cellbox 接受创建 | 934 ms | 锁、输入摘要、Box/Operation/幂等键的持久化 |
| 创建运行资源 | 3 ms | 提交 Kubernetes CR |
| 保存 Runtime Handle | 803 ms | 持久化 CR 身份等运行资源引用 |
| 等待 Running | 1,440 ms | 等待运行资源、观察状态并持久化、验证 Guest 健康 |
| 操作完成持久化 | 803 ms | 更新 Operation 与 Box 引用 |
| 凭证交付 | 67 ms | 工具运行配置与交付确认 |
| 产品准备 | 7 ms | 挂载能力和工作目录路径处理 |
| App Server 验证 | 70 ms | WebSocket 连接与真实 initialize RPC |
| 其他调用衔接 | 88 ms | 上述阶段间的状态更新和调用开销 |

显式的三个元数据阶段共 2,540 ms，占这一样本约 60.1%。等待 Running 内还包含观察状态的持久化，不能将整个 1,440 ms 归因于 Kubernetes 调度。

Pod 启动与保存 Handle 有重叠。保留的四份 Kubernetes 追踪中，CR 提交到 Scheduled 约 70–290 ms，其中还包括 Controller 处理时间；仅凭这些追踪不能将它当作纯 Scheduler 耗时。70 ms 的最终验证也不是 Codex 进程冷启动耗时，进程此前已由 Launcher 并行启动。

元数据写入仍有聚合账本问题：每次小修改都执行 pending PUT、state 条件 PUT 和 pending 条件 DELETE，两个 PUT 携带整份新状态。没有对锁等待、序列化和每次 S3 请求分别计时，因此不能把约 0.9 秒继续精确拆分。

## 4. 聚合账本现状

一次只读检查的账本为 2,702,626 字节：

| 集合 | 记录数 | 字节数 | 占比 |
| --- | --- | --- | --- |
| Executions，含 stdout/stderr | 1,081 | 1,386,130 | 51.3% |
| Operations | 1,379 | 506,175 | 18.7% |
| Boxes，含 Profile 和 Handle | 91 | 299,482 | 11.1% |
| 幂等 Keys | 1,379 | 298,013 | 11.0% |
| Grants | 632 | 201,510 | 7.5% |
| Routes、Leases 等 | — | 约 11 KB | 0.4% |

其中 1,077 次执行已结束，1,379 个操作全部结束，73 个 Box 已删除，632 个 Grant 全部过期。命令 stdout/stderr 自身约 1.11 MB。

这不是生产保留策略已经确定的证据，不能据此直接删记录。它说明历史与控制状态混在一起，使新建几 KB 的记录也要上传约 5.4 MB，并在远程 I/O 期间持有全局 Store 锁。

## 5. 后续设计：限定状态职责与生命周期

本节是后续方案，本次 PR 不实现。

### 5.1 存储分工

| 信息 | 建议归属 | 保留原则 |
| --- | --- | --- |
| 资源归属、镜像、挂载、期望状态 | 对应 Kubernetes CR spec/metadata | 随有效资源存在 |
| 当前阶段、实例身份、恢复和激活检查点 | Controller 维护的 CR status | 每项状态只有一个权威写入方 |
| Handle、Service 地址、连接 Token | 可重建的有界内存缓存 | 运行身份变化失效 |
| Profile | 不可变配置版本或内容摘要 | 不给每个 Box 重复保存完整副本 |
| 未完成操作和请求意图 | 小记录事务存储 | 完成或明确终止后进入保留窗口 |
| 已完成操作与幂等键 | 小记录事务存储 | 按 API 明确约定的期限一起清理 |
| stdout/stderr | 独立结果对象或日志存储 | 大小上限、保留期限、按需读取 |
| Grant、Lease、Access、Session | 支持到期清理的短期存储 | 有效记录保持跨重启语义，到期清理 |
| 已删除资源 | 短期 tombstone 和独立历史 | 解除归档等引用后清理 |
| Archive | OSS 数据加独立 manifest | 自包含、无需源 Box 即可恢复 |

Kubernetes 的配置 generation 不能直接替代运行实例 generation：Pod/容器替换未必修改 CR spec。仍需独立的运行身份和旧请求校验。

CR 状态是最终一致的观察结果，展示可使用 Watch 缓存；执行和凭证写入仍需验证当前资源归属和实例身份。Docker provider 不能照搬 CR 存储，应通过 provider 边界和小记录存储保留必要生命周期元数据。

### 5.2 创建和恢复协议

1. 一次事务保存请求摘要、幂等键、操作 ID、目标资源 ID 和必要创建意图。稳定资源名称由同一目标 ID 生成。
2. 幂等创建 CR；已有资源必须核对所有权和不可变配置，不能直接采用同名对象。
3. Controller 按期望状态推进。恢复须完成数据恢复和配置交付后才能激活，不提前公布可用。
4. API 通过 Watch 等待状态；完成后只更新目标操作的小记录。查询资源状态不触发持久化。
5. API 重启后依据未完成意图和实际资源继续或明确终止处理；不重放结果未知的命令执行。

请求事务与 CR 创建之间不存在跨系统原子事务。必须通过稳定 ID、幂等重试和恢复扫描处理“记录已提交、CR 尚未创建”与“CR 已创建、响应丢失”等窗口。

### 5.3 清理前必须解除的依赖

- Keys 当前只保存摘要和 OperationID。增加到期信息，操作结果与幂等映射必须一致清理；未完成操作不能按普通结果 TTL 删除。
- Archive 当前某些恢复和镜像删除检查依赖源 Box 的 ImportedImageID。先将导入镜像引用和恢复所需配置补齐到 manifest，迁移旧记录后才能清理源 Box。
- 有效 Lease 和可撤销 Grant 不能简单改成内存，除非明确改变 API 重启和多副本下的约束。清理须保持流访问与生命周期互斥。
- Profile 引用必须使用不可变版本，不能引用一个会被操作员修改的当前 ProfileID 后就删除历史配置。
- pending intent 支撑旧聚合账本恢复和独立镜像写入 fencing；只有新事务协议完成验证和迁移后才能移除。

保留期限尚未定稿，不在本轮自动清理数据。超过结果查询窗口后的 API 行为也需要明确约定，不能静默返回空结果或重新执行历史请求。

### 5.4 实施顺序与验收

1. 拆出执行输出，补齐 expiry 和可独立恢复的 Archive manifest；制定查询、重试和删除保留策略。
2. 把短期操作与幂等记录改为按条事务存储。可评估现有 MySQL 的独立 Cellbox 表；单实例本地存储与多实例共享存储的部署约束分别评审。
3. 统一 Kubernetes 生命周期到 CR，消除重复 Box 状态、Handle 持久化及查询写入。
4. 迁移既有账本，验证断点、未知结果、回滚和引用完整性，再停止旧聚合账本写入。

验收不仅测新建和 restore，还需注入接受请求后崩溃、CR 创建后响应丢失、Pod/容器替换、恢复未完成、撤销 Grant 和到期清理等场景。操作耗时和写入量应不随累计历史线性增长；分别统计锁等待、序列化、存储请求、Controller、Scheduler、Guest 与 App Server 的阶段。

减少状态持久化是下一轮压缩启动时间的主要方向，但不能以目前的小样本承诺新建或 restore 稳定小于 5 秒，也不能仅靠这项改动保证 1 秒启动。

## 6. 提交和验证范围

本轮代码包含 CoCell 与 Cellbox 的互补改动，需要两个仓库的 PR。部署时需要支持共享字段的 CRD/Controller、API、包含 Launcher/Guest 更新的 Sandbox 镜像和 CoCell；启用前准备宿主机目录，并核对挂载路径和节点一致。

在两个仓库的最新 master 基础上重新验证通过：CoCell 85 个针对性 TypeScript 测试、8 个 Launcher/诊断模型测试、pnpm build（含 typecheck）、Helm lint 和开启挂载的模板渲染、Shell/Python 语法检查；Cellbox service/provider/guest/controller/api 的 Go race 测试和相关 go vet。

本轮没有修改生产历史保留策略、迁移元数据存储或执行历史清理。最新 master 已合并的 Docker 发布、模型发现、PWA 和历史恢复功能不属于本轮新增优化。
