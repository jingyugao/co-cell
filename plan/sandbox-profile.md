# Sandbox Profile：镜像与平台解耦方案

## 目标

让 CoCell 可以运行用户自定义 Docker 镜像，而不要求镜像继承内置
`swarm-hive-sandbox`。镜像运行契约由 profile 声明；内置镜像只是默认
profile 的一种实现。

凭据不属于 profile。用户通过根目录 `sandbox.toml` 配置宿主机到
Sandbox 的文件/目录挂载。Meegle 等 CLI 的凭据格式、加密、刷新和
准备均由用户负责，CoCell 不读取、解密或转换这些凭据。

## Profile 格式

```toml
[image]
reference = "swarm-hive-sandbox:latest"

[runtime]
user = "user"
workspace = "/home/user/workspace"
codex_home = "/home/user/.codex"
runtime_home = "/home/user/.codex-web"
app_server_token = "/home/user/.codex-web/app-server-token"
app_server_mode = "image" # image | platform

[capabilities]
app_server = true
archive = true
sqlite_checkpoint = true
shell = "sh"
base64 = true
tar = true
```

`image` 模式表示镜像入口自行启动并监听 Codex App Server；平台提供
`CODEX_APP_SERVER_PORT`、`CODEX_APP_SERVER_ARGS` 和 capability token。
`platform` 模式表示平台在容器创建后以 profile 的 `user` 启动 App
Server，适用于只提供基础运行环境的镜像。

## 默认兼容值

未配置 profile 时，使用当前内置镜像的等价默认值：`user`、
`/home/user/workspace`、`/home/user/.codex` 和
`/home/user/.codex-web`。这保证已有项目、备份和 Compose 部署不变。

## 实施步骤

1. 新建 `backend/sandboxes/profile.ts`：读取并严格校验 profile；拒绝
   相对容器路径、重复路径、非法用户和未知 capability。
2. 在 `backend/index.ts` 创建单一 profile 实例，将镜像、工作目录、
   token 目标、挂载目标和 gVisor 进程参数全部从 profile 取得。
3. 改造 `DockerSandboxClient`：创建、exec、App Server token 读取、
   归档和恢复不再写死 `user` 或 `/home/user`。
4. 改造 `docker-provider` 与 `ContainerCodexRuntime`：将 Codex home、
   runtime home、共享文档目录和默认命令用户作为运行时依赖注入。
5. 改造 gVisor provider：使用同一 profile 构造 uid/gid、cwd、环境与
   OCI mounts；没有声明的 capability 返回可操作的配置错误。
6. 更新 Compose、`.env.example` 和文档；`sandbox.toml` 继续只管理
   用户挂载。

## 验收标准

- 默认 profile 可创建、执行、归档、恢复现有 Sandbox。
- 一个非继承内置镜像的示例 profile 可完成 App Server 会话。
- 自定义用户和工作目录不再出现 `/home/user` 硬编码。
- profile 缺少必要 capability 时，在创建前返回明确错误。
- 凭据目录只由 `sandbox.toml` 挂载，平台不包含任何 Meegle 特例。
