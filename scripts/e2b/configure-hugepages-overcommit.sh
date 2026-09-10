#!/usr/bin/env bash
# Configure the local E2B Firecracker HugeTLB pool:
# 16 GiB preallocated (8192 × 2 MiB) plus 32 GiB allocated on demand.
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

readonly SYSCTL_FILE=/etc/sysctl.d/60-e2b-hugepages.conf
readonly BASE_PAGES=8192
readonly OVERCOMMIT_PAGES=16384

if [[ $(awk '/^Hugepagesize:/ { print $2 }' /proc/meminfo) != 2048 ]]; then
  echo "Expected 2 MiB HugeTLB pages; refusing to change configuration." >&2
  exit 1
fi

install -d -m 0755 /etc/sysctl.d
tmp=$(mktemp "${SYSCTL_FILE}.XXXXXX")
trap 'rm -f "$tmp"' EXIT
printf '%s\n' \
  '# E2B local sandbox pool: 16 GiB base + 32 GiB on-demand HugeTLB overcommit.' \
  "vm.nr_hugepages = ${BASE_PAGES}" \
  "vm.nr_overcommit_hugepages = ${OVERCOMMIT_PAGES}" >"$tmp"
install -m 0644 "$tmp" "$SYSCTL_FILE"
sysctl --load="$SYSCTL_FILE"

echo 'Configured E2B HugeTLB capacity:'
sysctl vm.nr_hugepages vm.nr_overcommit_hugepages
