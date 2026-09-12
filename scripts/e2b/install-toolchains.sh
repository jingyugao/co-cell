#!/bin/bash
set -euo pipefail

manifest=/opt/codex-template/toolchains.json
field() { node -e 'const m=require(process.argv[1]); let v=m; for(const k of process.argv[2].split("."))v=v[k]; console.log(Array.isArray(v)?v.join(" "):v)' "$manifest" "$1"; }

if [[ "${1:-}" == root ]]; then
  chmod 0755 /
  available_kib=$(df -Pk /home/user | awk 'NR == 2 {print $4}')
  if (( available_kib < 4 * 1024 * 1024 )); then
    echo "Development template needs at least 4 GiB free during installation; available: ${available_kib} KiB. Configure the local E2B project's build disk allowance to 8 GiB before rebuilding." >&2
    exit 1
  fi
  apt-get update
  apt-get install -y --no-install-recommends $(field systemPackages)
  rm -rf /var/lib/apt/lists/*
  download_dir=$(mktemp -d)
  trap 'rm -rf "$download_dir"' EXIT
  mise_version=$(field mise.version)
  uv_version=$(field uv.version)
  curl -fL --retry 3 "https://github.com/jdx/mise/releases/download/v${mise_version}/mise-v${mise_version}-linux-x64.tar.gz" -o "$download_dir/mise.tar.gz"
  printf '%s  %s\n' "$(field mise.sha256)" "$download_dir/mise.tar.gz" | sha256sum -c -
  tar -xzf "$download_dir/mise.tar.gz" -C "$download_dir"
  install -m 0755 "$download_dir/mise/bin/mise" /usr/local/bin/mise
  curl -fL --retry 3 "https://github.com/astral-sh/uv/releases/download/${uv_version}/uv-x86_64-unknown-linux-gnu.tar.gz" -o "$download_dir/uv.tar.gz"
  printf '%s  %s\n' "$(field uv.sha256)" "$download_dir/uv.tar.gz" | sha256sum -c -
  tar -xzf "$download_dir/uv.tar.gz" -C "$download_dir"
  install -m 0755 "$download_dir/uv-x86_64-unknown-linux-gnu/uv" /usr/local/bin/uv
  install -m 0755 "$download_dir/uv-x86_64-unknown-linux-gnu/uvx" /usr/local/bin/uvx
  install -d -o user -g user /opt/codex-runtime/bin /home/user/.codex-web/runtime /home/user/.codex /home/user/workspace
  exit 0
fi

[[ "$HOME" == /home/user ]] || { echo 'Installer must run as the sandbox user with its normal home directory' >&2; exit 1; }
export PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
export MISE_YES=1
export MISE_GO_SET_GOROOT=true
for version in $(field go); do mise install "go@$version"; done
for version in $(field node); do
  mise install "node@$version"
  mise exec "node@$version" -- npm install --global "pnpm@$(field pnpm)"
done
for tool in $(field extraMiseTools); do mise use -g "$tool"; done
mise use -g "go@$(field defaults.go)" "node@$(field defaults.node)"
for version in $(field python); do uv python install "$version"; done
uv python pin --global "$(field defaults.python)"
mkdir -p /home/user/.local/bin
ln -sfn "$(uv python find "$(field defaults.python)")" /home/user/.local/bin/python
ln -sfn "$(uv python find "$(field defaults.python)")" /home/user/.local/bin/python3

# Codex control processes keep a separate Node executable; project mise switches
# only affect project commands and cannot switch the worker's interpreter.
node_dir=$(mise where "node@$(field defaults.node)")
install -m 0755 "$node_dir/bin/node" /opt/codex-runtime/bin/node
export PATH="$node_dir/bin:$PATH"
cd /home/user/.codex-web/runtime
npm install --no-audit --no-fund --save-exact "@openai/codex@$(field codexCli)"
mise reshim

export PATH=/home/user/.local/share/mise/shims:/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
for version in $(field go); do GOTOOLCHAIN=local mise exec "go@$version" -- go version; done
for version in $(field node); do mise exec "node@$version" -- node --version; done
for version in $(field python); do uv run --no-project --python "$version" python --version; done
/opt/codex-runtime/bin/node --version
du -sh /home/user/.local/share/mise/installs/go /home/user/.local/share/mise/installs/node /home/user/.local/share/uv/python
# Only download/install caches are removed; all installed toolchains remain.
rm -rf /home/user/.cache/mise /home/user/.cache/uv /home/user/.npm/_cacache
