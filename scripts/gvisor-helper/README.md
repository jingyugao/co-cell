# gVisor helper

独立运行在宿主机上的 gVisor `runsc` HTTP 服务。Docker 中的 Web 通过
`http://host.docker.internal:8090` 访问它，不需要访问宿主机的 `runsc` 或 Docker socket。

宿主机需要安装官方 CNI 插件。Ubuntu 24.04 可执行：

```sh
sudo apt install containernetworking-plugins
```

```sh
GVISOR_HELPER_HOST=127.0.0.1 \
GVISOR_HELPER_PORT=8090 \
GVISOR_ROOT=/var/lib/swarm-hive/gvisor \
GVISOR_BUNDLE_ROOT=/var/lib/swarm-hive/gvisor/bundles \
GVISOR_CNI_PATH=/usr/lib/cni \
GVISOR_CNI_SUBNET=10.89.0.0/16 \
node scripts/gvisor-helper/server.mjs
```

接口：`GET /health`，以及 `POST /v1/actions`。请求和响应均为 JSON；当前为内部服务，未启用鉴权：

```json
{"action":"checkpoint","sandboxId":"demo"}
{"action":"restore","sandboxId":"demo","checkpointId":"demo-123"}
{"action":"state","sandboxId":"demo"}
{"action":"exec","sandboxId":"demo","command":"id","user":"user"}
{"action":"forward","sandboxId":"demo","remotePort":40000}
```

`bundlePath` 必须位于 `GVISOR_BUNDLE_ROOT` 下，避免 HTTP 客户端把任意宿主机目录交给 `runsc`。该模块只负责调用宿主机 `runsc`；OCI bundle 的创建和镜像转换由上层 provider 负责。

helper 会为每个 Sandbox 建立独立 network namespace，并调用 CNI `bridge`、`host-local` 和 `loopback` 配置网卡与默认路由。它为整个专用子网维护一条出站 NAT 规则，并在 `FORWARD` 顶部维护一条同子网互访的拒绝规则，阻止 Sandbox 通过共享 bridge 直接访问彼此。restore 前会用 CNI 重建同名 namespace 的网络，因为 runsc 会把接口配置导入自身 netstack；删除 Sandbox 时通过 CNI `DEL` 清理网卡和 IPAM。`GVISOR_CNI_NETWORK`、`GVISOR_CNI_BRIDGE` 和 `GVISOR_CNI_SUBNET` 必须与本机已有 Docker/Kubernetes 网络错开。

`forward` 会启动 `runsc port-forward`，将一个随机宿主机端口转发至 guest 的 `remotePort`。gVisor provider 对每个 Sandbox 保持两条转发：Codex App Server 端口，以及 guest `40000` 的 `sandbox-proxy`；普通项目服务通过后者的 `/<targetPort>/...` 路径访问。
