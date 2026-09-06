#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID != 0 ]] || { echo '请使用普通用户执行。' >&2; exit 1; }
root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root_dir"
node scripts/e2b-render-systemd.mjs
systemd-analyze --user verify deploy/e2b/systemd/e2b-api.service deploy/e2b/systemd/e2b-proxy.service deploy/e2b/systemd/e2b.target
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d "$unit_dir"
for file in e2b-api.service e2b-proxy.service e2b.target; do
  install -m 644 "deploy/e2b/systemd/$file" "$unit_dir/$file"
done
systemctl --user daemon-reload
# Migrate only exact legacy binaries owned by this user; root orchestrator
# and its sandbox children are not touched by this installer.
for service in api proxy; do
  if systemctl --user is-active --quiet "e2b-$service.service"; then continue; fi
  binary=$service
  [[ $service != proxy ]] || binary=client-proxy
  for proc in /proc/[0-9]*; do
    if [[ $(readlink "$proc/exe" 2>/dev/null || true) != "$root_dir/data/e2b/bin/$binary" ]]; then continue; fi
    [[ $(stat -c %u "$proc") == "$UID" ]] || continue
    pid=${proc##*/}
    kill -TERM "$pid"
    for ((i=0;i<90;i++)); do
      [[ -e /proc/$pid/exe ]] || break
      sleep 1
    done
    if [[ -e /proc/$pid/exe ]]; then
      echo "$service 尚未退出，未强制终止。" >&2; exit 1
    fi
  done
done
for service in postgres redis clickhouse; do
  container=$(docker compose -f deploy/e2b/compose.yaml ps -q "$service")
  [[ -z $container ]] || docker update --restart unless-stopped "$container" >/dev/null
done
systemctl --user enable --now e2b.target
systemctl --user --no-pager status e2b-api.service e2b-proxy.service
