#!/usr/bin/env bash
set -Eeuo pipefail
root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
data_dir="$root_dir/data/e2b"
source_dir="$root_dir/tmp/e2b-infra"
action=${1:---help}
[[ $# -le 1 ]] || { echo '只接受一个子命令。' >&2; exit 2; }
trap 'echo "E2B 步骤失败（行 $LINENO），数据会保留。" >&2' ERR
case "$action" in
  --help|help)
    cat <<'HELP'
用法：bash scripts/e2b-local.sh <命令>
  prepare       下载最小虚拟机组件，编译后端，生成本地配置（不执行 SQL）
  init          初始化 E2B 专用数据库并生成 API key；由用户执行
  orchestrator  前台运行沙箱编排器，需要 sudo（会提示密码）
  api           前台运行 API，端口 13000
  proxy         前台运行沙箱代理，端口 13002，健康端口 13003
  template      构建 base 模板（上述三个服务运行后执行）
  demo          创建临时沙箱，读写文件、执行命令，并清理该测试沙箱

所有运行数据、模板、二进制和密钥位于 data/e2b。
init 会执行数据库迁移和 seed，仅指向本地 E2B 专用端口。
API、proxy、orchestrator 使用独立终端；Ctrl-C 停止前台服务。
这是单沙箱开发验证配置，不是生产部署；12 GB / 50 GB 尚非总量硬限制。
HELP
    exit 0 ;;
  prepare|init|api|proxy|orchestrator|template|demo) ;;
  *) echo "未知命令：$action" >&2; exit 2 ;;
esac
if [[ $action == orchestrator && $EUID != 0 ]]; then
  exec sudo bash "$root_dir/scripts/e2b-local.sh" orchestrator
fi
if [[ $action != orchestrator && $EUID == 0 ]]; then
  echo '此子命令请以普通用户执行。' >&2; exit 1
fi
umask 077
mkdir -p "$data_dir/bin"
export GOFLAGS=-p=2 GOMEMLIMIT=2GiB GOMAXPROCS=2
download() {
  local object=$1 dest=$2
  [[ -s $dest ]] && return
  mkdir -p "$(dirname -- "$dest")"
  curl -fL --retry 3 --connect-timeout 20 --max-time 300 \
    "https://storage.googleapis.com/e2b-artifact-binaries/$object" -o "$dest.part"
  mv -- "$dest.part" "$dest"
}
load_config() {
  local service=$1
  [[ -s "$data_dir/config/$service.env" ]] || { echo '先执行 prepare。' >&2; exit 1; }
  set -a
  source "$data_dir/config/$service.env"
  set +a
}
load_key() {
  [[ -s "$data_dir/api-key" ]] || { echo '先执行 init 生成 API key。' >&2; exit 1; }
  export E2B_API_KEY
  E2B_API_KEY=$(< "$data_dir/api-key")
  export LOCAL_E2B_API_URL=http://127.0.0.1:13000
  export LOCAL_E2B_SANDBOX_URL=http://127.0.0.1:13002
  export LOCAL_E2B_TEMPLATE=base
}
cd "$root_dir"
case "$action" in
  prepare)
    [[ -f "$source_dir/go.work" ]] || { echo '缺少 tmp/e2b-infra 官方源码。' >&2; exit 1; }
    [[ $(git -C "$source_dir" rev-parse HEAD) == 04db4f13610e7c73927648b91b154ee220ca6dc5 ]] || {
      echo '源码版本已变化，需要重新核对内核、Firecracker 和配置后再构建。' >&2; exit 1;
    }
    [[ $(uname -m) == x86_64 ]] || { echo '此配置目前仅适配 x86_64。' >&2; exit 1; }
    compat_patch="$root_dir/deploy/e2b/patches/sync-wp-env.patch"
    if git -C "$source_dir" apply --check "$compat_patch" 2>/dev/null; then
      git -C "$source_dir" apply "$compat_patch"
    elif ! git -C "$source_dir" apply --reverse --check "$compat_patch" 2>/dev/null; then
      echo '同步 UFFD 兼容补丁与源码不匹配，请检查本地修改。' >&2; exit 1
    fi
    download firecrackers/v1.14-0.2.0/amd64/firecracker "$data_dir/artifacts/firecrackers/v1.14-0.2.0/amd64/firecracker"
    chmod +x "$data_dir/artifacts/firecrackers/v1.14-0.2.0/amd64/firecracker"
    download kernels/vmlinux-6.1.158/amd64/vmlinux.bin "$data_dir/artifacts/kernels/vmlinux-6.1.158/amd64/vmlinux.bin"
    bash "$source_dir/packages/orchestrator/scripts/fetch-busybox.sh" 1.36.1 amd64 "$data_dir/artifacts/busybox/1.36.1/amd64/busybox"
    for service in orchestrator api client-proxy envd; do
      target=build
      [[ $service != orchestrator ]] || target=build-local
      make -C "$source_dir/packages/$service" "$target"
      install -m 755 "$source_dir/packages/$service/bin/$service" "$data_dir/bin/$service.next"
      mv -f "$data_dir/bin/$service.next" "$data_dir/bin/$service"
    done
    (cd "$source_dir/packages/local-dev" && go build -o "$data_dir/bin/seed" seed-local-database.go)
    (cd "$source_dir/packages/db" && go tool goose --version)
    (cd "$source_dir/packages/clickhouse" && go tool goose --version)
    node scripts/e2b-local-config.mjs
    echo '准备完成。下一步由用户执行：bash scripts/e2b-local.sh init'
    ;;
  init)
    [[ -x "$data_dir/bin/seed" ]] || { echo '先执行 prepare。' >&2; exit 1; }
    docker compose -f "$root_dir/deploy/e2b/compose.yaml" ps
    # Deliberately fixed dedicated endpoints: never consume ambient database URLs.
    (cd "$source_dir/packages/db" && GOOSE_DBSTRING='postgres://postgres:postgres@127.0.0.1:15432/postgres?sslmode=disable' go tool goose -table _migrations -dir migrations postgres up)
    (cd "$source_dir/packages/clickhouse" && GOOSE_DBSTRING='clickhouse://clickhouse:clickhouse@127.0.0.1:19000/default' go tool goose -table _migrations -dir migrations clickhouse up)
    POSTGRES_CONNECTION_STRING='postgres://postgres:postgres@127.0.0.1:15432/postgres?sslmode=disable' \
      SEED_TEAM_API_KEY=random SEED_TEAM_API_KEY_FILE="$data_dir/api-key" "$data_dir/bin/seed"
    echo '初始化完成；请分别在三个终端执行 orchestrator、api、proxy 子命令。'
    ;;
  api)
    load_config api
    cd "$data_dir"
    exec "$data_dir/bin/api" --port 13000
    ;;
  proxy)
    load_config client-proxy
    cd "$data_dir"
    exec "$data_dir/bin/client-proxy"
    ;;
  orchestrator)
    load_config orchestrator
    cd "$data_dir"
    exec "$data_dir/bin/orchestrator"
    ;;
  template)
    load_key
    exec pnpm exec tsx scripts/e2b-local-template.ts
    ;;
  demo)
    load_key
    exec pnpm exec tsx scripts/e2b-local-demo.ts
    ;;
esac
