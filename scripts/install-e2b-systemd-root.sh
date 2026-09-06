#!/usr/bin/env bash
set -Eeuo pipefail
root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $# == 0 ]] || { echo '此脚本不接受参数。' >&2; exit 2; }
if ((EUID != 0)); then exec sudo bash "$root_dir/scripts/install-e2b-systemd-root.sh"; fi
unit_source="$root_dir/deploy/e2b/systemd/e2b-orchestrator.service"
[[ -f $unit_source ]]
systemd-analyze verify "$unit_source"
if systemctl is-active --quiet e2b-orchestrator.service; then
  echo '编排器已经由 systemd 管理，未重启正在运行的服务。'
  exit 0
fi
# Do not stop the legacy process when there are live sandboxes, or the API
# cannot confirm the state. Never send signals to its Firecracker children.
legacy_pids=()
for proc in /proc/[0-9]*; do
  if [[ $(readlink "$proc/exe" 2>/dev/null || true) == "$root_dir/data/e2b/bin/orchestrator" ]]; then
    legacy_pids+=("${proc##*/}")
  fi
done
if ((${#legacy_pids[@]})); then
  /usr/bin/node --input-type=module - "$root_dir" <<'JS'
import {readFileSync} from 'node:fs';
const root=process.argv[2];
const r=await fetch('http://127.0.0.1:13000/sandboxes', {
  headers:{'X-API-Key':readFileSync(`${root}/data/e2b/api-key`,'utf8').trim()},
  signal:AbortSignal.timeout(5000), redirect:'error'
});
if(!r.ok) throw new Error(`无法核实沙箱状态：HTTP ${r.status}`);
const rows=await r.json();
if(!Array.isArray(rows) || rows.length) throw new Error('仍有沙箱运行或状态不明，拒绝停止编排器；请先保存并暂停工作区。');
JS
  for pid in "${legacy_pids[@]}"; do
    kill -TERM "$pid"
    for ((i=0;i<90;i++)); do
      [[ -e /proc/$pid/exe ]] || break
      sleep 1
    done
    if [[ -e /proc/$pid/exe ]]; then
      echo '编排器尚未退出，未强制终止。稍后重试。' >&2; exit 1
    fi
  done
fi
install -m 644 "$unit_source" /etc/systemd/system/e2b-orchestrator.service
systemctl daemon-reload
systemctl enable --now e2b-orchestrator.service
for ((i=0;i<60;i++)); do
  if curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:5008/health >/dev/null 2>&1; then
    systemctl --no-pager status e2b-orchestrator.service
    exit 0
  fi
  if systemctl is-failed --quiet e2b-orchestrator.service; then break; fi
  sleep 2
done
journalctl -u e2b-orchestrator.service -n 30 --no-pager
exit 1
