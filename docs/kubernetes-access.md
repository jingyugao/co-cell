# Kubernetes 凭据

当前使用专用 ServiceAccount `codex-devtools/swarm-hive-admin`，通过 ClusterRoleBinding `swarm-hive-admin` 绑定内置 `cluster-admin`。三个集群（common、example_data、example_extra）各签发一个不自动到期的令牌，合并为一份 kubeconfig；删除对应 Secret 或账号可撤销。

初始化运行 `pnpm kubernetes:configure`，会写入宿主 `~/.kube/swarm-hive-admin.json`（0600），然后运行 `pnpm credentials:import` 导入平台加密存储。已有宿主 kubeconfig 保持不变。沙箱使用平台下发的专用凭据。

每轮任务直接同步已保存的凭据，不再扫描 RBAC、申请 TokenRequest 或按分钟刷新令牌。旧开发调试凭据需要重新导入；更新运行服务前先等待活动任务完成。暂停的沙箱在下一轮任务准备时取得新凭据。

管理权限覆盖 Kubernetes RBAC 全部资源和非资源路径；实际操作仍须符合用户任务授权及共享规则。禁止创建临时 Pod；变更 SQL 及 DDL 必须通过 request_user_approval 获得用户对具体操作的同意。共享规则来源是 `data/AGENTS.md` 和 `data/docs/connections.md`，不由本文件下发。

完整操作及撤销说明见 [长期管理员凭据](../tmp/docs/kubernetes-static-admin.md)。旧 `provision-kubernetes-readonly.ts` 工具保留供历史环境维护，当前凭据下发流程不使用它。
