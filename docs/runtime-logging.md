# 运行日志

结构化 JSONL 日志默认保存在宿主项目的 `data/logs/`，不提交 Git。日志由 Web 服务持久化，沙箱暂停或删除不会移除已收到的记录。worker 和 HTTP 诊断代理在每轮启动时准备。

## 查看

```sh
tail -F data/logs/runtime-$(date -u +%F).jsonl
rg '"sessionId":"<会话ID>"' data/logs/
```

按 `sessionId`、`projectId`、`turnId` 定位任务；按 `requestId` 串联一次模型 HTTP 交换。上游返回的 `requestIds` 可用于对照模型代理日志，日志时间为 UTC。

## 记录范围

- 任务生命周期：模型、执行环境、关联沙箱、耗时、状态和错误。
- SDK 错误与工具元数据：工具类型、ID、状态和退出码，不记录命令或工具正文。
- E2B Responses 请求：HTTP 状态、耗时、字节数、安全的请求标识。
- 流式终止：区分 `response.completed`、`response.failed`、`response.incomplete` 与 `error`；没有终止事件的断流单独诊断。
- 过载重试：次数、间隔、原通道解析与重试结果，见 [模型过载重试](model-overload-retries.md)。

HTTP 200 不等于模型任务成功，应同时查看 SSE 的终止结果和任务最终状态。日志记录经过脱敏的错误信息，不保存原始请求正文、模型回复、工具参数与结果、Authorization 或 Cookie。需要原始协议正文时使用独立的 [HTTP 抓包工具](http-capture.md)。

文件权限为 0600，目录为 0700；按 UTC 日期分文件，达到约 20 MiB 后滚动，同一天保留当前文件及一个归档，清理七天前的自有日志。日志写入失败会输出简短 stderr 提示，不阻断任务。

## 排障边界

HTTP 诊断覆盖配置了代理地址的 E2B Codex 请求，本地执行仅记录任务生命周期与 SDK 事件。诊断不能补出启用前的历史 HTTP，也不能观察远端代理内部改写或转发的完整过程。

页面断开不会结束任务。Web 服务重启会中断活动任务，之后通过持久历史恢复展示和继续会话；日志中的服务停止、任务取消或启动时恢复记录可辅助识别这种情况。
