#!/usr/bin/env bash
set -Eeuo pipefail
root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root_dir"
[[ $EUID != 0 ]] || { echo '请使用普通用户执行。' >&2; exit 1; }
[[ $# == 0 ]] || { echo '此脚本不接受参数。' >&2; exit 2; }
# Stop only after confirming there is no live workspace to interrupt.
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const key=readFileSync('data/e2b/api-key','utf8').trim();
const r=await fetch('http://127.0.0.1:13000/sandboxes', {
  headers:{'X-API-Key':key}, signal:AbortSignal.timeout(5000), redirect:'error'
});
if(!r.ok) throw new Error(`无法核实沙箱状态：HTTP ${r.status}`);
const rows=await r.json();
if(!Array.isArray(rows)||rows.length) throw new Error('有活动沙箱或状态不明，拒绝重启；请先保存并暂停工作区。');
JS
sudo systemctl restart e2b-orchestrator
# The local discovery client can retain the previous instance's unhealthy
# node after an orchestrator restart. Refresh the user API's node registry.
systemctl --user restart e2b-api.service
ready=false
for ((i=0;i<60;i++)); do
  if curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:5008/health >/dev/null 2>&1 && \
     curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:13000/health >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
[[ $ready == true ]] || { echo '服务健康检查未通过，请检查编排器日志。' >&2; exit 1; }
exec bash scripts/e2b-local.sh demo
