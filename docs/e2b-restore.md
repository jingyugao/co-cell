# 本机 E2B 服务维护与重建

本项目可以连接本机部署的 E2B。以下命令适用于安装在 `~/.data/e2b` 的配套部署；该安装包、客户端与 `restore.sh` 不随当前仓库提供。其他 E2B 部署应使用其对应的维护方式。

## 日常检查

配套部署由用户 systemd 管理 API 和代理、系统 systemd 管理编排器、Docker Compose 管理数据库：

```sh
systemctl --user status e2b-api e2b-proxy
systemctl status e2b-orchestrator
docker compose -f ~/.data/e2b/compose.yaml ps
journalctl --user -u e2b-api -u e2b-proxy -n 100
sudo journalctl -u e2b-orchestrator -n 100
```

默认 API 地址为 `http://127.0.0.1:13000`，沙箱代理为 `http://127.0.0.1:13002`，API key 保存在 `~/.data/e2b/config/api-key`。通过以下命令运行客户端探测；它会实际创建沙箱：

```sh
node ~/.data/e2b/client/demo.mjs
```

Docker 服务需要运行。构建失败时同时检查宿主内存、大页、磁盘和 E2B 项目额度；模板资源配置不能超过这些条件。具体额度由部署决定，不应从 Web 页面配置推断宿主实际可用资源。

## 重建

重建脚本用于重新安装或初始化服务，不是恢复已删除沙箱的数据。操作前应停止 Web 活动任务，备份 E2B 持久存储、Web 数据目录和凭据密钥，并阅读本机脚本确认其初始化范围。

```sh
bash ~/.data/e2b/restore.sh
```

配套脚本需要 sudo，并可能停止旧服务、初始化数据库、安装 systemd 单元、构建基础模板和执行沙箱探测。不要将其作为普通的服务重启命令。

重建后检查 API 与代理地址和认证，再启动 Web 服务。若基础模板或项目额度改变，重新构建开发模板；现有沙箱不会因为模板重建自动更换磁盘或环境。恢复项目映射需要原来的 E2B 沙箱数据，仅恢复 Web 元数据（MySQL 或 `data/web-state/` 的 JSON） 不足以恢复工作区。
