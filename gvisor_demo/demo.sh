#!/bin/bash
# gVisor ptrace checkpoint/restore demo
# 环境: WSL2, runsc release-20260907.0
set -euo pipefail

BUNDLE_DIR="$HOME/.cache/gvisor-ckpt-demo"
IMAGE_DIR="$HOME/.cache/gvisor-ckpt-demo-images"
CONTAINER_ID="demo"
PLATFORM="ptrace"
RUNSC="sudo /usr/bin/runsc -platform=$PLATFORM"
LOG="/tmp/gvisor-demo-container.log"

# ---- helpers ----
say()  { echo -e "\n\033[1;36m>>> $*\033[0m"; }
step() { echo -e "\033[1;33m--- $*\033[0m"; }
die()  { echo -e "\033[1;31mFATAL: $*\033[0m"; exit 1; }

wait_running() {
    local max=10
    for ((n=0; n<max; n++)); do
        local status
        status=$($RUNSC list 2>/dev/null | awk -v id="$CONTAINER_ID" '$1==id{print $3}')
        if [ "$status" = "running" ]; then
            return 0
        fi
        sleep 0.5
    done
    die "容器 $CONTAINER_ID 未在 ${max}s 内进入 running 状态"
}

cleanup() {
    $RUNSC kill "$CONTAINER_ID" KILL 2>/dev/null || true
    sleep 0.5
    $RUNSC delete -force "$CONTAINER_ID" 2>/dev/null || true
    sudo rm -rf "$IMAGE_DIR" 2>/dev/null || true
    sudo rm -rf "$BUNDLE_DIR" 2>/dev/null || true
    rm -f "$LOG"
}

# ---- 前置检查 ----
preflight() {
    local err=0
    command -v docker   >/dev/null 2>&1 || { die "docker 未安装"; err=1; }
    command -v python3  >/dev/null 2>&1 || { die "python3 未安装"; err=1; }
    [ -x /usr/bin/runsc ]           || { die "/usr/bin/runsc 不存在"; err=1; }
    sudo -n true 2>/dev/null        || { die "sudo 需要密码，请先执行 sudo -v"; err=1; }
    return $err
}

main() {
    preflight

    say "1. 准备 OCI bundle"
    cleanup
    mkdir -p "$BUNDLE_DIR/rootfs"

    # 拉镜像、导出 rootfs
    step "导出 alpine rootfs..."
    CID=$(docker create --platform=linux/amd64 alpine:latest 2>&1)
    docker export "$CID" 2>/dev/null | sudo tar -C "$BUNDLE_DIR/rootfs" -xf -
    docker rm "$CID" > /dev/null 2>&1

    # 注入计数器脚本
    sudo tee "$BUNDLE_DIR/rootfs/counter.sh" > /dev/null << 'SCRIPT'
#!/bin/sh
set -e
F=/tmp/counter.txt
echo "0" > $F
i=1
while true; do
    echo "$i" > $F
    echo "[$(date +%H:%M:%S)] tick $i"
    i=$((i + 1))
    sleep 1
done
SCRIPT
    sudo chmod +x "$BUNDLE_DIR/rootfs/counter.sh"

    # 生成 OCI spec
    cd "$BUNDLE_DIR"
    $RUNSC spec -- /bin/sh /counter.sh
    sudo chown "$USER:$USER" config.json

    # 关掉 terminal（checkpoint 要求非交互终端）
    python3 -c "
import json
with open('config.json') as f:
    c = json.load(f)
c['process']['terminal'] = False
with open('config.json','w') as f:
    json.dump(c, f, indent=2)
"

    say "2. 创建并启动容器"
    $RUNSC create "$CONTAINER_ID"
    $RUNSC start "$CONTAINER_ID" > "$LOG" 2>&1 &
    wait_running
    sleep 4  # 等计数器跑几秒

    step "容器跑了几秒后的计数器值:"
    VAL=$($RUNSC exec "$CONTAINER_ID" cat /tmp/counter.txt)
    echo "  counter = $VAL"
    [ -n "$VAL" ] && [ "$VAL" -gt 1 ] || die "计数器异常"

    say "3. checkpoint（保存容器状态到磁盘）"
    sudo mkdir -p "$IMAGE_DIR"
    $RUNSC checkpoint \
        -image-path="$IMAGE_DIR" \
        -leave-running=false \
        "$CONTAINER_ID"
    step "checkpoint 产物:"
    sudo ls -lh "$IMAGE_DIR" | sed 's/^/  /'

    say "4. 从 checkpoint 恢复容器"
    $RUNSC delete "$CONTAINER_ID"
    $RUNSC restore -detach -image-path="$IMAGE_DIR" "$CONTAINER_ID"
    wait_running
    sleep 2

    step "恢复后的计数器值:"
    VAL2=$($RUNSC exec "$CONTAINER_ID" cat /tmp/counter.txt)
    echo "  counter = $VAL2"

    say "5. 结果"
    if [ -n "$VAL2" ] && [ "$VAL2" -gt "$VAL" ]; then
        echo -e "  \033[1;32m✅ checkpoint/restore 成功\033[0m"
        echo "  checkpoint 时 counter=$VAL，恢复后 counter=$VAL2（继续递增，未归零）"
    else
        die "counter 未按预期递增 (ckpt=$VAL, restore=$VAL2)"
    fi

    say "6. 清理"
    $RUNSC kill "$CONTAINER_ID" KILL 2>/dev/null || true
    sleep 0.5
    $RUNSC delete -force "$CONTAINER_ID" 2>/dev/null || true
    sudo rm -rf "$IMAGE_DIR" "$BUNDLE_DIR"
    echo "  完成"
}

main "$@"