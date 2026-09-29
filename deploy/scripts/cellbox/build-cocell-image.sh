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
proxy_config="${COCELL_PROXY_TOOLS_CONFIG:-$cocell_root/deploy/mybox/sandbox.toml}"
proxy_tools=""
build_context="$cocell_root/deploy/box-wrap"
if [[ -f "$proxy_config" ]]; then
  proxy_tools="$(python3 "$cocell_root/deploy/scripts/cellbox/prepare-proxy-tools.py" "$proxy_config" "$user_base_image" "$build_dir/proxy-output")"
  if [[ -n "$proxy_tools" ]]; then
    build_context="$build_dir/context"
    mkdir -p "$build_context"
    cp -a "$cocell_root/deploy/box-wrap/." "$build_context/"
    mv "$build_dir/proxy-output/wrappers" "$build_context/wrappers"
    mv "$build_dir/proxy-output/proxy-policies" "$build_context/proxy-policies"
    mv "$build_dir/proxy-output/proxy-tool-ids.json" "$build_context/proxy-tool-ids.json"
    printf '\nCOPY --chmod=0755 wrappers/ /usr/local/bin/\nCOPY --chmod=0755 proxy-policies/ /opt/cellbox/tools/\nCOPY --chmod=0644 proxy-tool-ids.json /opt/product/cocell/proxy-tool-ids.json\n' >> "$build_context/Dockerfile"
  fi
elif [[ -n "${COCELL_PROXY_TOOLS_CONFIG:-}" ]]; then
  echo "Proxy tool config does not exist: $proxy_config" >&2
  exit 2
fi
(
  cd "$cellbox_root"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$build_dir/cellbox-guest" ./cmd/cellbox-guest
)
docker build --platform linux/amd64 --file "$build_context/Dockerfile" --build-arg "COCELL_USER_BASE_IMAGE=$user_base_image" --build-arg "COCELL_PROXY_TOOLS=$proxy_tools" --tag "$base_tag" "$build_context"
(
  cd "$cellbox_root"
  go run ./cmd/cellbox-image -base "$base_tag" -guest "$build_dir/cellbox-guest" -platform linux/amd64
)
