# 项目与会话

项目是 Docker Sandbox、工作目录和会话的稳定所有者。创建项目时可以填写飞书需求详情 URL，由宿主机 Meegle CLI 读取需求名称；不绑定需求时手工填写项目名。创建项目或会话不会启动容器，首次发送任务时才创建。

项目内多个会话共享同一容器和工作区，各自保存 Codex thread 与网页历史。同一会话一次只执行一个任务；不同会话允许并行。

## 页面与状态

- 会话地址为 `/sessions/<会话ID>`，项目的新会话入口为 `/projects/<项目ID>`。
- `/#projects` 按“使用中”“已完成”“归档”展示项目。
- 使用中项目可进入、编辑或标记完成。
- 已完成项目不能继续对话，可以恢复为使用中；满 `SANDBOX_ARCHIVED_RECLAIM_AFTER_MS` 后由巡检归档。
- 归档会删除当前 Docker 容器，并清除项目与会话上的 Sandbox 引用。
- 归档项目不能直接进入，只显示“重建 Sandbox”。重建创建全新的空容器，并把项目恢复为使用中。
- 会话可以单独归档；归档会话只读，取消归档后可继续使用。

归档和重建不复制旧工作区、系统安装或旧容器内的 `~/.codex`。网页保存的消息仍可查看，但不能代替 Codex 原生 thread 数据。

## 持久化

未配置 MySQL 时，项目 JSON 位于 `data/web-state/projects/`，会话 JSON 位于 `data/web-state/`。配置 `MYSQL_URL` 后使用 MySQL。`project.sandbox` 是当前项目绑定的权威来源；`session.sandbox` 是随项目同步的会话快照。

归档记录保留 `archivedAt`、被删除容器 ID 和生命周期历史，但不会保留可恢复的 Sandbox 引用。重建后的容器必须使用新的 ID。

## API

| 方法 | 路径 | 含义 |
| --- | --- | --- |
| GET | `/api/projects` | 项目列表、会话数和活动会话 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/:id` | 项目详情 |
| PATCH | `/api/projects/:id` | 修改名称、需求 URL 或在使用中与已完成间切换 |
| POST | `/api/projects/:id/archive` | 归档项目，删除并解绑 Sandbox |
| POST | `/api/projects/:id/sandbox/rebuild` | 为归档项目创建全新 Sandbox |
| DELETE | `/api/projects/:id` | 删除项目、会话和当前 Sandbox |
| POST | `/api/sessions` | 指定 `projectId` 创建会话 |

## 文件与服务链接

项目文件链接通过 `/projects/:id/files?path=...` 定位当前项目 Sandbox。归档后没有 Sandbox，因此文件和预览不可用，且不会触发自动重建。

Docker Sandbox 使用 host network。回复中的 `localhost`、`127.0.0.1`、`0.0.0.0` 等本地服务链接，经项目预览接口校验后跳转到 `http://127.0.0.1:<端口>`。服务应监听 `0.0.0.0`；不同项目监听相同端口会冲突。
