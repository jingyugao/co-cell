# 归档模块

## 设计

采用 **archive_info（流）+ archive_versions（版本链）** 两张表，事务保证 `is_latest` 一致性。

```
archive_info                     archive_versions
┌──────────────────────┐         ┌───────────────────────────┐
│ archive_key (PK)     │         │ id (PK)                   │
│ latest_version_id ───┼───────→│ archive_key                │
│ created_at           │         │ version (递增)             │
│ updated_at           │         │ parent_id (自引用)         │
└──────────────────────┘         │ is_latest                  │
                                 │ storage_path               │
                                 │ size_bytes                 │
                                 │ sha256                     │
                                 │ metadata (JSON)            │
                                 │ status (active|deleted)    │
                                 └───────────────────────────┘
```

## 核心操作

### 创建版本
```
BEGIN
  SELECT ... FROM archive_info WHERE key=? FOR UPDATE  // 行锁
  INSERT archive_versions (is_latest=TRUE, parent_id=旧最新ID)
  UPDATE archive_info SET latest_version_id=新ID
  UPDATE 旧版本 SET is_latest=FALSE
COMMIT
```

### 保留 N 个版本 (retain)
```
BEGIN
  SELECT ... FOR UPDATE  // 锁流
  SELECT version FROM archive_versions
    WHERE key=? AND status='active'
    ORDER BY version DESC LIMIT 1 OFFSET N-1
  → 找不到 = 版本不够 N，什么都不删
  UPDATE archive_versions SET status='soft_deleted'
    WHERE key=? AND is_latest=FALSE AND version < cutoff
COMMIT
```

**安全保证**：`is_latest=FALSE` 条件确保最新版本永远不会被删除。总数不足 N 时 OFFSET 超出范围，子查询返回空，不做任何操作。

### 物理清理 (sweep)
定期扫描 `status='soft_deleted'` 的记录，删除物理文件后 `DELETE` 数据库行。

## SQLite WAL Checkpoint

**问题**：归档时 App Server 正在运行，SQLite 处于 WAL 模式。tar 打包的 `.sqlite-wal` 文件在恢复后与新的 App Server 进程不兼容，导致线程数据丢失。

**修复** (`packages/docker-sandbox/src/client.ts`)：
```typescript
// archive() 前：对所有 .sqlite 文件做 checkpoint
for db in /home/user/.codex/*.sqlite; do
  sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE)"
done
```

## 文件结构

```
backend/archives/
├── types.ts      — ArchiveStream, ArchiveVersion, CreateArchiveVersionInput
├── store.ts      — ArchiveStore: 数据层，MySQL 事务操作
├── manager.ts    — ArchiveManager: 业务编排 + 物理文件管理
└── routes.ts     — API: 归档列表、版本查询、文件浏览、清理触发
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/archives` | 项目归档摘要（兼容旧表） |
| GET | `/api/archives/:key/versions` | 归档流版本列表 |
| GET | `/api/archives/:key/files?path=` | 浏览归档内文件 |
| GET | `/api/archives/:key/file?path=` | 读取归档内文件内容 |
| POST | `/api/archives/prune` | 全局清理旧版本 |

## 集成点

- `SessionManager.archiveProjectNow()` — 完整归档 + 删除 Sandbox
- `SessionManager.scheduledArchive()` — 1 分钟定时扫描，30 分钟阈值快照
- `SessionManager.rebuildProjectSandbox()` — 重建时从 ArchiveManager 读取最新归档恢复
- 前端 `ArchiveVersionBadge` + `ArchiveViewer` — hover 版本列表 + 文件浏览