#!/usr/bin/env bash
set -eu
role=${1:?api, proxy or orchestrator required}
attempt=0
while [[ $role == orchestrator ]] || ((attempt<75)); do
  ready=true
  if [[ $role == proxy ]]; then
    curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:13000/health >/dev/null 2>&1 || ready=false
  else
    for port in 15432 16379 19000; do
      timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null || ready=false
    done
    if [[ $role == api ]]; then
      curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:5008/health >/dev/null 2>&1 || ready=false
    fi
  fi
  [[ $ready == true ]] && exit 0
  attempt=$((attempt+1))
  sleep 2
done
echo 'E2B 依赖未就绪；请确认 Docker Desktop、数据库和编排器已启动。' >&2
exit 1
