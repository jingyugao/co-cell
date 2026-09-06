#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo '此检查需要 root。' >&2; exit 1; }
[[ -c /dev/kvm ]] || { echo '缺少 /dev/kvm' >&2; exit 1; }
modprobe nbd nbds_max=64
[[ $(cat /sys/module/nbd/parameters/nbds_max) -ge 4 ]]
[[ $(awk '/^Hugepagesize:/ {print $2}' /proc/meminfo) == 2048 ]]
pages=$(sysctl -n vm.nr_hugepages)
if ((pages < 2048)); then
  sysctl -w vm.nr_hugepages=2048
fi
[[ $(sysctl -n vm.nr_hugepages) -ge 2048 ]] || {
  echo '无法分配 4 GiB 大页，请释放内存后重试。' >&2; exit 1;
}
