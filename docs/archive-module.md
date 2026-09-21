# 归档

归档用于在保留项目数据的同时回收 Sandbox，减少长期闲置环境的磁盘占用。重新开始工作时，使用最新备份创建并验证新环境，再切换项目绑定。

## 备份、归档与恢复

| 操作 | 行为 |
| --- | --- |
| 备份 | 保存工作区和 Codex 状态，保留当前环境 |
| 归档 | 生成并校验备份，停止和解绑环境，回收 Sandbox |
| 恢复 | 校验最新备份，创建新环境、还原数据并验证，成功后切换绑定 |

运行环境正常时，归档先生成新备份。环境异常且无法生成新备份时，可以确认使用已有备份归档；此时保存范围以该备份为准。

恢复会核对文件存在性、大小与 SHA-256。最新备份缺失或损坏时停止操作；新环境验证成功后才成为项目的当前环境。清理失败的旧环境保留待清理记录，后续扫描继续处理。

## 保存范围

数据归档格式包含项目工作区和 `/home/user/.codex`，用于保留代码及原生会话状态。共享知识、凭据配置和应用元数据单独维护、备份。

镜像之外临时安装的系统软件通过镜像或初始化流程重建。归档文件自身仍占磁盘，可结合版本保留策略控制占用。

项目操作层通过 provider 的 `archive/restoreArchive` 接口执行数据备份与恢复；Docker 后端的具体实现位于 [DockerSandboxClient](../packages/docker-sandbox/src/client.ts)。gVisor 运行状态 checkpoint 的流程见 [Sandbox](sandbox-module.md)。

## 周期备份与版本

后台每分钟扫描项目，按 `SANDBOX_SCHEDULED_ARCHIVE_THRESHOLD_MS` 判断是否备份，默认阈值为 30 分钟。周期备份保留运行环境；项目归档才回收环境。

配置 MySQL 后，版本化归档使用两张表：

- `archive_info`：归档流，指向最新版本。
- `archive_versions`：版本、文件路径、大小、SHA-256 和来源元数据。

创建版本通过事务更新最新指针。保留策略把旧版本标记为待清理，物理清理再删除文件和记录；最新版本受保留条件保护。

未启用版本化归档管理时，项目操作层也支持文件备份及项目中的备份元数据。默认文件目录为 `data/sandbox-data-archives/`，迁移时应连同对应元数据一起保存。

## 接口与实现

| 接口 | 用途 |
| --- | --- |
| `POST /api/projects/:id/backup` | 立即备份 |
| `POST /api/projects/:id/archive` | 归档项目；可显式选择已有备份 |
| `POST /api/projects/:id/sandbox/rebuild` | 从最新备份恢复 |
| `GET /api/archives/:key/versions` | 查看归档版本 |
| `GET /api/archives/:key/files` | 浏览备份中的文件 |
| `GET /api/archives/:key/file` | 读取备份中的文件内容 |
| `POST /api/archives/prune` | 清理旧版本 |

实现入口：[项目备份与恢复编排](../backend/projects/sandbox-operations.ts)、[归档管理](../backend/archives/manager.ts)、[版本存储](../backend/archives/store.ts)。
