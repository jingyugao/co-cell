#!/usr/bin/env bash
set -Eeuo pipefail

# Build once after installing/updating the local E2B infrastructure source.
# Usage: bash scripts/e2b/build-archive-inspector.sh [e2b-directory] [output]
repository_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
e2b_directory=${1:-"$HOME/.data/e2b"}
inspector_output=${2:-"$repository_dir/data/tools/inspect-build"}
[[ $# -le 2 ]] || { echo 'Usage: build-archive-inspector.sh [e2b-directory] [output]' >&2; exit 2; }
if [[ -f "$e2b_directory/config/go-binary" ]]; then
  go_binary=$(< "$e2b_directory/config/go-binary")
else
  go_binary=$(command -v go)
fi
mkdir -p -- "$(dirname -- "$inspector_output")"
inspector_output=$(realpath -m -- "$inspector_output")
temporary_output="${inspector_output}.partial.$$"
trap 'rm -f -- "$temporary_output"' EXIT
cd -- "$e2b_directory/infra/packages/orchestrator"
CGO_ENABLED=0 GOMAXPROCS=2 GOFLAGS=-p=2 "$go_binary" build -o "$temporary_output" ./cmd/inspect-build
chmod 755 "$temporary_output"
mv -f -- "$temporary_output" "$inspector_output"
echo "Built $inspector_output"
