#!/usr/bin/env bash
set -Eeuo pipefail
root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root_dir"
launcher="$root_dir/scripts/e2b-local.sh"
state_dir="$root_dir/data/e2b"
[[ $EUID != 0 ]] || { echo '请用普通用户运行，脚本会提示 sudo 密码。' >&2; exit 1; }
[[ $# == 0 ]] || { echo '用法：bash scripts/e2b-local-up.sh' >&2; exit 2; }
umask 077
mkdir -p "$state_dir/logs" "$state_dir/pids"
trap 'echo "启动未完成，请查看 data/e2b/logs。已启动的服务和数据会保留。" >&2' ERR

for service in api orchestrator client-proxy envd seed; do
  [[ -x "$state_dir/bin/$service" ]] || {
    echo '首次准备尚未完成，请先运行 bash scripts/e2b-local.sh prepare' >&2
    exit 1
  }
done
for port in 13000 13002 13003 5007 5008 5009 5109; do
  if [[ -n $(ss -H -ltn "sport = :$port") ]]; then
    echo "端口 $port 已占用，不重复启动或停止已有服务。" >&2
    echo '如果 E2B 已启动，可以直接执行 bash scripts/e2b-local.sh demo。' >&2
    exit 1
  fi
done

sudo -v
echo '1/5 初始化本地 E2B 数据库…'
bash "$launcher" init
# Refresh after initialization in case compilation/migrations took a while.
sudo -v

echo '2/5 后台启动编排器…'
nohup sudo -n bash "$launcher" orchestrator > "$state_dir/logs/orchestrator.log" 2>&1 < /dev/null &
orchestrator_pid=$!
printf '%s\n' "$orchestrator_pid" > "$state_dir/pids/orchestrator.pid"

wait_health() {
  local url=$1 pid=$2 name=$3
  for ((attempt=0; attempt<90; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name 已退出，请查看 data/e2b/logs/$name.log" >&2
      return 1
    fi
    if curl --noproxy '*' -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "$name 健康检查超时，请查看 data/e2b/logs/$name.log" >&2
  return 1
}
wait_health http://127.0.0.1:5008/health "$orchestrator_pid" orchestrator

echo '3/5 后台启动 API 和代理…'
nohup bash "$launcher" api > "$state_dir/logs/api.log" 2>&1 < /dev/null &
api_pid=$!
printf '%s\n' "$api_pid" > "$state_dir/pids/api.pid"
nohup bash "$launcher" proxy > "$state_dir/logs/proxy.log" 2>&1 < /dev/null &
proxy_pid=$!
printf '%s\n' "$proxy_pid" > "$state_dir/pids/proxy.pid"
wait_health http://127.0.0.1:13000/health "$api_pid" api
wait_health http://127.0.0.1:13003/health "$proxy_pid" proxy

echo '4/5 构建基础模板…'
bash "$launcher" template
echo '5/5 运行接入 Demo…'
bash "$launcher" demo
echo '验证完成，后端继续在后台运行。日志位于 data/e2b/logs。'
