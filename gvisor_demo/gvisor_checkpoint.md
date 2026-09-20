# gVisor on WSL2：ptrace 模式 + Checkpoint/Restore 验证

## 环境

| 项 | 值 |
|---|-----|
| 宿主机 | Windows 11 + WSL2 |
| WSL 内核 | `6.18.33.2-microsoft-standard-WSL2` |
| Docker | 29.1.3 |
| runsc | release-20260907.0, go1.26.3 |

## 结论

### systrap —— ❌ 不可用

`systrap` 在 WSL2 中 panic：

```
panic: failed to create a syscall thread
```

根因：systrap 通过 `seccomp(SECCOMP_RET_TRAP)` + `SIGSYS` 信号机制创建 syscall
拦截线程，WSL2 定制内核与该线程创建路径不兼容。以 root 运行、跳过 cgroup、
关闭 network namespace 均无法绕过。

相关文档：

- gVisor 平台文档：<https://gvisor.dev/docs/architecture_guide/platforms/>
- systrap README：<https://github.com/google/gvisor/blob/master/pkg/sentry/platform/systrap/README.md>

gVisor 官方从未宣称支持 WSL2，GitHub issues 中也没有 WSL2 + systrap 相关讨论。

### ptrace —— ✅ 工作正常

`ptrace` 平台在 WSL2 中完整可用：网络、文件系统、checkpoint/restore 均通过。

`ptrace` 比 `systrap` 慢（每个 syscall 都要走 `PTRACE_SYSEMU`），但在 WSL2 中这是唯一可行的平台。

## Docker Runtime 配置

`/etc/docker/daemon.json`：

```json
{
    "runtimes": {
        "runsc": {
            "path": "/usr/bin/runsc"
        },
        "runsc-ptrace": {
            "path": "/usr/local/bin/runsc-ptrace"
        }
    }
}
```

`/usr/local/bin/runsc-ptrace` 是 wrapper：

```sh
#!/bin/sh
exec /usr/bin/runsc -platform=ptrace "$@"
```

使用方式：

```bash
docker run --runtime=runsc-ptrace alpine uname -a
# Linux ... 4.19.0-gvisor ...   ← 确认跑在 gVisor sentry 内核
```

## Checkpoint / Restore 实测

### 原理

gVisor 的 sentry 是纯 Go 用户态进程，checkpoint 本质上是把 Go 进程的堆/栈/寄存器
序列化到磁盘，restore 时反序列化恢复执行。

- `checkpoint.img` —— sentry 内核状态（goroutine 栈、内核对象等）
- `pages.img` —— 内存页内容
- `pages_meta.img` —— 内存页元数据

### 实测流程

用一个每秒递增计数器的 shell 脚本作为有状态应用：

```sh
#!/bin/sh
COUNT_FILE=/tmp/counter.txt
echo "0" > $COUNT_FILE
i=1
while true; do
    echo "$i" > $COUNT_FILE
    echo "[$(date +%H:%M:%S)] tick $i"
    i=$((i + 1))
    sleep 1
done
```

操作步骤：

```bash
# 1. 准备 OCI bundle
cd /tmp/gvisor-ckpt
runsc spec -- /bin/sh /counter.sh
# 编辑 config.json：terminal=false，platform=ptrace

# 2. 创建并启动容器
runsc -platform=ptrace create ckpt-test
runsc -platform=ptrace start ckpt-test &

# 3. 等待计数器跑几秒
runsc -platform=ptrace exec ckpt-test cat /tmp/counter.txt
# → 4

# 4. checkpoint（停止容器并保存状态）
runsc -platform=ptrace checkpoint \
    -image-path=/tmp/gvisor-ckpt-images \
    -leave-running=false ckpt-test

ls -lh /tmp/gvisor-ckpt-images/
# checkpoint.img  179K
# pages.img       120K
# pages_meta.img  474B

# 5. 清理旧容器，从 checkpoint 恢复
runsc -platform=ptrace delete ckpt-test
runsc -platform=ptrace restore \
    -image-path=/tmp/gvisor-ckpt-images ckpt-test &

# 6. 验证计数器从 checkpoint 时刻继续，没归零
runsc -platform=ptrace exec ckpt-test cat /tmp/counter.txt
# → 52（从 4 继续递增，不是从 0 开始）
```

### 注意事项

- `runsc restore` 在前台运行会阻塞（因为容器主进程是无限循环），需要放后台。
- checkpoint 文件只对同一 `runsc` 版本兼容，跨版本可能无法恢复。
- `-leave-running=false` 表示 checkpoint 后立即停止原容器；设为 `true` 则原容器继续运行。
- Docker（moby）不暴露 checkpoint/restore API，必须直接用 `runsc` 操作 OCI bundle。

## 限制

| 特性 | WSL2 状态 |
|------|-----------|
| systrap（默认平台） | ❌ panic |
| ptrace | ✅ |
| KVM | ❌ 无嵌套虚拟化 |
| rootless | ❌ 缺少 newuidmap |
| cgroup v2 | ❌ 权限不足 |
| 沙箱网络 | ✅ |
| checkpoint/restore | ✅ |