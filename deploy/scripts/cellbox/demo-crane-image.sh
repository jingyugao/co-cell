#!/usr/bin/env bash
# Demonstrate image composition with crane; do not deploy the result.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
crane="${CRANE_BIN:-crane}"
base="${COCELL_DEMO_BASE_IMAGE:-node:22.18.0-bookworm-slim}"
payload="${COCELL_DEMO_PAYLOAD_IMAGE:-cocell-demo-product:local}"
guest="${CELLBOX_GUEST_BINARY:-$repo_root/../cell-box/dist/release/cellbox-container-agent}"
port="${COCELL_DEMO_REGISTRY_PORT:-15002}"
registry="127.0.0.1:$port"
registry_container=""
payload_container=""

cleanup() {
  if [[ -n "$payload_container" ]]; then docker rm "$payload_container" >/dev/null || true; fi
  if [[ -n "$registry_container" ]]; then docker stop "$registry_container" >/dev/null || true; fi
}
trap cleanup EXIT

for command in docker tar curl jq; do
  command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 2; }
done
command -v "$crane" >/dev/null || { echo "Missing crane: set CRANE_BIN" >&2; exit 2; }
docker image inspect "$payload" >/dev/null 2>&1 || {
  echo "Missing prebuilt CoCell payload image: $payload (set COCELL_DEMO_PAYLOAD_IMAGE)" >&2
  exit 2
}
test -x "$guest" || { echo "Missing Cellbox guest binary: $guest" >&2; exit 2; }

mkdir -p "$repo_root/tmp"
work="$(mktemp -d "$repo_root/tmp/crane-image-demo.XXXXXX")"
mkdir -p "$work/user/usr/local/bin" "$work/cocell/usr/local/lib/node_modules/@openai" \
  "$work/cocell/usr/local/bin" "$work/cocell/opt/product" "$work/cocell/opt/cellbox" \
  "$work/cellbox/opt/cellbox/bin"
printf '#!/bin/sh\necho user-base-command\n' > "$work/user/usr/local/bin/user-base-command"
chmod 0755 "$work/user/usr/local/bin/user-base-command"

# The CoCell payload is built once, separately. This demo only composes images.
payload_container="$(docker create "$payload")"
docker cp "$payload_container:/usr/local/lib/node_modules/@openai/codex" "$work/cocell/usr/local/lib/node_modules/@openai/codex"
printf '#!/bin/sh\nexec /usr/local/bin/node /usr/local/lib/node_modules/@openai/codex/bin/codex.js "$@"\n' > "$work/cocell/usr/local/bin/codex"
chmod 0755 "$work/cocell/usr/local/bin/codex"
docker cp "$payload_container:/opt/product/cocell" "$work/cocell/opt/product/cocell"
docker cp "$payload_container:/opt/cellbox/tools" "$work/cocell/opt/cellbox/tools"
docker rm "$payload_container" >/dev/null
payload_container=""
cp "$guest" "$work/cellbox/opt/cellbox/bin/cellbox-container-agent"
chmod 0755 "$work/cellbox/opt/cellbox/bin/cellbox-container-agent"

for layer in user cocell cellbox; do
  tar --sort=name --owner=0 --group=0 --numeric-owner -cf "$work/$layer.tar" -C "$work/$layer" .
done

registry_container="$(docker run --rm -d --name "cocell-crane-demo-$$" \
  --publish "127.0.0.1:$port:5000" registry:3)"
for attempt in {1..30}; do
  if curl --silent --fail "http://$registry/v2/" >/dev/null; then break; fi
  sleep 0.2
done
curl --silent --fail "http://$registry/v2/" >/dev/null

user_image="$registry/cocell-crane-demo:user"
cocell_image="$registry/cocell-crane-demo:cocell"
cellbox_image="$registry/cocell-crane-demo:cellbox"
final_image="$registry/cocell-crane-demo:final"
"$crane" append --insecure --platform linux/amd64 -b "$base" -f "$work/user.tar" -t "$user_image"
"$crane" append --insecure --platform linux/amd64 -b "$user_image" -f "$work/cocell.tar" -t "$cocell_image"
"$crane" append --insecure --platform linux/amd64 -b "$cocell_image" -f "$work/cellbox.tar" -t "$cellbox_image"
"$crane" mutate --insecure --platform linux/amd64 "$cellbox_image" \
  --label cocell.demo=crane --workdir /workspace --tag "$final_image"

docker pull "$final_image" >/dev/null
docker run --rm --network none --entrypoint /bin/sh "$final_image" -c \
  'user-base-command; codex --version; test -x /opt/product/cocell/launcher.mjs && echo cocell-launcher-present; test -x /opt/cellbox/bin/cellbox-container-agent && echo cellbox-container-agent-present'
"$crane" config --insecure "$final_image" | jq -e '.config.Labels["cocell.demo"] == "crane"' >/dev/null
printf 'Crane composition passed: %s\nArtifacts: %s\n' "$final_image" "$work"
