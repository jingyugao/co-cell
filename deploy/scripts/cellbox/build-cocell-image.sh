#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 CELLBOX_SOURCE_DIR" >&2
  exit 2
fi

cocell_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cellbox_root="$(cd "$1" && pwd)"
base_tag="cocell-product-base:local"
user_base_image="${COCELL_USER_BASE_IMAGE:-node:22.18.0-bookworm-slim}"

if [[ ! -f "$cellbox_root/cmd/cellbox-image/main.go" ]]; then
  echo "Cellbox source is missing" >&2
  exit 2
fi

build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
(
  cd "$cellbox_root"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$build_dir/cellbox-guest" ./cmd/cellbox-guest
)
docker build --file "$cocell_root/deploy/cellbox/Dockerfile" --build-arg "COCELL_USER_BASE_IMAGE=$user_base_image" --tag "$base_tag" "$cocell_root/cellbox/cocell"
(
  cd "$cellbox_root"
  go run ./cmd/cellbox-image -base "$base_tag" -guest "$build_dir/cellbox-guest" -platform linux/amd64
)
