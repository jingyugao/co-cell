# Kubernetes 开发调试权限

Agent 使用 `codex-devtools/codex-developer-readonly` ServiceAccount。保留历史资源名称以兼容现有绑定和令牌，当前策略版本为 `developer-debug-v2`。

| 能力 | 权限 |
| --- | --- |
| 查看已有资源、日志、Pod 指标、ConfigMap、Secret | 原有资源的 `get/list/watch` |
| 在已有 Pod 内执行命令 | `pods/exec` 的 `get/create` |
| 将已有 Pod 端口转发到本地 | `pods/portforward` 的 `get/create` |
| 新建、删除、修改 Service、Pod、Deployment 等资源 | 不授权 |
| 扩缩容、重启部署、驱逐 Pod、添加临时容器、修改 RBAC | 不授权 |

`create` 仅授予两个连接子资源，不授予 Pod、Service 或其他实体资源。主角色必须精确匹配代码策略；额外 RoleBinding/ClusterRoleBinding 的继承权限也会检查，发现越权时拒绝签发凭据，不回退到宿主身份。

这些限制由 Agent 的 Kubernetes 身份执行。Exec 允许在容器内运行命令，并不保证容器内部只读；Pod 内挂载的凭据或其他身份有各自权限。Agent 不应借用这些身份绕过限制执行服务创建、删除或其他运维变更。

实际下发的共享规则位于 `data/AGENTS.md`，连接知识库位于 `data/docs/connections.md`。两处已同步更新为开发调试约定，包括权限生效前的检查、运维操作禁止和 SQL 约束；每轮任务准备时重新读取并同步到沙箱。这些运行数据被 Git 忽略。本说明自身不会作为知识库下发。

## 更新与验证

升级需要协调后端代码、集群 RBAC 和凭据同步。旧后端会拒绝扩大的角色；新后端会拒绝旧策略版本的凭据。先等待活动任务结束，再在维护窗口完成下列步骤，避免中间状态接收新任务：

1. 停止旧 Web 后端。
2. 更新集群角色：`pnpm kubernetes:configure common example_data example_extra`。
3. 更新加密凭据：`pnpm credentials:import`。
4. 使用新代码启动 Web 后端。当前仓库入口是 `server/index.ts`，可使用 `pnpm dev`；生产环境先执行 `pnpm build`，再使用 `pnpm start`。端口及其他启动配置沿用现有部署配置。

上述集群名来自本机 kubeconfig，其他环境先执行 `kubectl config get-contexts`。无需重建模板或 Pod；沙箱会在下一轮任务准备时同步凭据。

验证类型检查：

```sh
pnpm typecheck
```

验证实际权限使用 `kubectl auth can-i`，不通过真正创建或删除资源来测试。以 `common` 为例：

```sh
kubectl --context common auth can-i create pods --subresource=exec --all-namespaces --as=system:serviceaccount:codex-devtools:codex-developer-readonly
kubectl --context common auth can-i create pods --subresource=portforward --all-namespaces --as=system:serviceaccount:codex-devtools:codex-developer-readonly
kubectl --context common auth can-i create services --all-namespaces --as=system:serviceaccount:codex-devtools:codex-developer-readonly
kubectl --context common auth can-i delete services --all-namespaces --as=system:serviceaccount:codex-devtools:codex-developer-readonly
kubectl --context common auth can-i patch deployments.apps --all-namespaces --as=system:serviceaccount:codex-devtools:codex-developer-readonly
```

前两项预期 `yes`，后三项预期 `no`。实际检查还应包含该 ServiceAccount 所属组及所有命名空间的额外绑定。

注意使用 `auth can-i create pods --subresource=exec`。`auth can-i create pods/exec` 会将 `exec` 解析为 Pod 名称，检查的是创建 Pod，可能返回误导性的 `no`。

2026-09-08 已将新 RBAC 实际应用到 `common`、`example_data`、`example_extra`，并重新导入 `developer-debug-v2` 凭据。使用专用 Agent 凭据验证 `example_data/example-service` 和 `example_data/dev` 的 exec 均返回 `yes`，实际执行 `exec -n dev example-tool-server -- true` 成功。三个集群的 Service/Pod 创建、删除、修改及 Deployment 修改、扩缩容仍被拒绝；扫描全部命名空间绑定未发现额外业务授权。

同次切换中，等待 `3001` Web 后端无运行任务后完成重启，新进程已加载当前代码，连接接口返回开发调试身份。下一轮任务会同步新凭据和共享规则。
