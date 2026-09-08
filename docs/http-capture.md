# 原始 HTTP 抓包

抓包工具观察 `本机 Codex SDK → 本机记录代理 → OPENAI_BASE_URL` 的请求与响应。它记录 Codex 发给所配置代理的协议正文，不代表代理转发给模型服务的内容；已有 rollout 也不能还原过去未抓取的 HTTP。

该工具独立于 Web 的常规运行日志，会保留请求上下文与响应正文。只在需要检查工具定义或协议时使用，产物留在已忽略的 `tmp/artifacts/http-capture/`，不要提交。

## 抓取与分析

需要配置 `OPENAI_BASE_URL`，以及本机 SDK 可用的模型认证：

```sh
pnpm capture:http
```

工具加载 `.env`，启动临时记录代理，在独立临时目录创建只读 SDK 会话，要求执行一个简单终端命令。运行上限为 120 秒；结束后关闭代理并生成解码文件与摘要，不修改正在运行的 Web 服务或已有会话。

仅分析已有目录，不发模型请求：

```sh
pnpm capture:http --analyze tmp/artifacts/http-capture/<抓包目录>
```

需要连续观察单独的本机 SDK 客户端时：

```sh
pnpm capture:http --serve
```

将输出的代理地址配置给该客户端，结束时按 Ctrl+C。代理只监听本机且不处理 WebSocket upgrade，客户端需使用 HTTP Responses。E2B 中的回环地址指向沙箱自身，不能把宿主 `--serve` 输出的回环地址直接配置给 E2B 任务；E2B 日常诊断使用 [运行日志](runtime-logging.md)。

## 产物

每次 HTTP 交换按序号存放在独立子目录：

| 文件 | 内容 |
| --- | --- |
| `request.json` | 方法、上游 URL、脱敏头、字节数及完成状态 |
| `request.body` | 请求体原始字节 |
| `request.decoded.json` | 解压并格式化的请求 JSON |
| `tools.json` | 提取的工具定义 |
| `response.json` | HTTP 状态、脱敏头及记录完成状态 |
| `response.body` | 响应体原始字节，包含 SSE |
| `response.decoded.txt` | 解压后的响应文本 |
| 外层 `summary.json` | 工具结构、返回调用、回传结果与事件类型 |

鉴权头、Cookie 和敏感查询参数在元数据中脱敏，转发时保留原认证。body 不会为脱敏而重写，仍可能包含上下文、业务数据或工具结果。目录权限为 0700，文件权限为 0600。

## 如何读工具协议

工具定义可能位于顶层 `tools`，也可能位于 `input` 内的 `additional_tools` 条目。工具名称和可用接口取决于 CLI、模型和配置，应以当次请求为准。

在响应中查找 `response.output_item.done` 的 `function_call` / `custom_tool_call`；随后请求中使用相同 `call_id` 的 output 条目是工具执行结果。若外层工具为 `exec`，其输入可能是编排内层工具调用的 JavaScript；它与 SDK 的命令或文件变更 item 不是同一层数据。

HTTP SSE 可以包含文本与工具输入 delta，而当前 TypeScript SDK 暴露的是 CLI item 事件。原始 HTTP 有增量不意味着 SDK 向页面提供相同粒度。

记录范围不包含 TLS/TCP 包、HTTP 分块帧或头字段原始大小写。`responseTransportComplete` 表示 HTTP 流是否完整结束，`responseProtocolCompleted` 表示是否收到 `response.completed`，两者可能不同。
