# 项目资源链接

Agent 原始消息保持不变。Markdown 渲染器根据消息所属项目和 `session.settings.workingDirectory` 解析资源；预览文档中的相对地址以当前文档目录为基准。

| 地址 | 行为 |
| --- | --- |
| `/home/user/workspace/tools/qg-proxy/README.md` | 项目文件预览 |
| `./README.md`、`src/main.go:42` | 相对会话工作目录解析，支持行号 |
| `file:///home/user/workspace/README.md` | 项目文件预览 |
| `sandbox:/files/tools/qg-proxy/README.md` | 相对项目工作区解析 |
| `sandbox:/ports/8000/`、`localhost:8000`、`0.0.0.0:8000` | 既有沙箱端口预览 |
| `https://example.com/test`、`www.example.com/test` | 外部链接，不转入沙箱 |
| `/api/users`、其他无法确认的本地路径 | 显示原文，不作为 Web 主站路由打开 |

普通左键点击文件会打开会话侧面的文件预览；支持 Markdown、带行号的文本和常见位图，可下载或独立打开。代码块保持原样，独立的行内代码路径可点击。工具返回的文件变更路径是确定的文件路径，因此也支持 `Dockerfile` 等无扩展名文件。

独立入口：`/projects/:projectId/files?path=<编码的绝对路径>&line=42`。该入口绑定项目，后端使用项目当前沙箱。它展示当前文件，不是消息生成时的历史快照；移动或删除文件后旧链接可能失效。

接口：`GET /api/projects/:id/files?path=...` 返回预览元数据和文本；`raw=1` 返回文件内容，`download=1` 强制下载。最大文件 10 MiB，UTF-8 文本预览最大 1 MiB，超出的文本可在总大小限制内下载。PNG/JPEG/GIF/WebP 按文件签名识别，允许内联显示；HTML/SVG 等文件只作为文本预览或附件下载，不在主页面执行。

后端只允许访问项目工作目录与 `/home/user/.codex/docs`，同时验证规范路径、真实路径和已打开的文件描述符，拒绝越界符号链接、目录和特殊文件。项目授权和允许目录由后端决定，前端识别不是权限边界。

访问会复用已有沙箱连接、恢复与续期逻辑。暂停时读取可能需要等待恢复；缺失文件、访问受限、超出大小及沙箱连接失败均显示明确错误。未知路径不会自动猜测另一个项目或宿主机文件。

文件名中的 `#`、`?`、`%` 应按 URL 编码，例如 `notes%23draft.md`；原始 `#` 表示文档锚点。会话工作目录不会随每次工具内部的 `cd` 自动改变；多仓库内的文件建议输出绝对路径，或者明确相对于会话工作目录的路径。
