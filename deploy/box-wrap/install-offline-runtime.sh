#!/bin/sh
set -eu
artifacts=/opt/cocell-artifacts
set -- "$artifacts"/debs/*.deb
if test -f "$1"; then
  # APT also looks in its archive cache for upgrades of already installed
  # packages (e.g. perl-base), even when all inputs use absolute .deb paths.
  cp "$@" /var/cache/apt/archives/
  DEBIAN_FRONTEND=noninteractive apt-get --no-download install -y --no-install-recommends "$@"
  rm -f /var/cache/apt/archives/*.deb
fi
rm -rf /var/lib/apt/lists/*
test "$(node --version)" = v22.18.0
codex=/usr/local/lib/node_modules/@openai/codex
rm -rf "$codex"
mkdir -p "$codex/node_modules/@openai/codex-linux-x64"
tar -xzf "$artifacts/codex.tgz" --strip-components=1 -C "$codex"
tar -xzf "$artifacts/codex-linux-x64.tgz" --strip-components=1 -C "$codex/node_modules/@openai/codex-linux-x64"
ln -sf "$codex/bin/codex.js" /usr/local/bin/codex
install -m 0755 "$artifacts/restic" /usr/local/bin/restic
codex_version="$(node -p 'JSON.parse(require("fs").readFileSync("/opt/product/cocell/deploy/box-wrap/runtime-packages.json")).codexVersion')"
restic_version="$(node -p 'JSON.parse(require("fs").readFileSync("/opt/product/cocell/deploy/box-wrap/runtime-packages.json")).resticVersion')"
test "$(codex --version)" = "codex-cli $codex_version"
restic version | grep -F "restic $restic_version "
