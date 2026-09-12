#!/bin/bash
set -euo pipefail

# Public tooling only: no host config or credentials belong in this image layer.
# These Oracle Debian packages support mysql --login-path / .mylogin.cnf.
# Package SHA256 values: https://repo.mysql.com/apt/debian/dists/bookworm/mysql-8.0/binary-amd64/Packages
# glab SHA256: https://gitlab.com/gitlab-org/cli/-/releases/v1.116.0/downloads/checksums.txt
[[ $(id -u) == 0 ]] || { echo 'Run command tool installation as root' >&2; exit 1; }
[[ $(dpkg --print-architecture) == amd64 ]] || { echo 'Command tools require amd64 Debian 12' >&2; exit 1; }
. /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 12 ]] || { echo 'Command tools require Debian 12' >&2; exit 1; }

mysql_version=8.0.46-1debian12
glab_version=1.116.0
lark_version=1.0.89
meegle_version=1.0.20
kubectl_version=v1.35.1
mysql_ready=false
glab_ready=false
lark_ready=false
meegle_ready=false
kubectl_ready=false
if [[ $(dpkg-query -W -f='${Version}' mysql-community-client 2>/dev/null || true) == "$mysql_version" ]] && command -v mysql >/dev/null; then mysql_ready=true; fi
if command -v glab >/dev/null && glab --version | head -n 1 | grep -Eq '^glab( version)? v?1\.116\.0([ (]|$)'; then glab_ready=true; fi
if command -v lark-cli >/dev/null && [[ $(lark-cli --version) == "lark-cli version $lark_version" ]]; then lark_ready=true; fi
if command -v meegle >/dev/null && [[ $(meegle --version) == "$meegle_version" ]]; then meegle_ready=true; fi
if command -v kubectl >/dev/null && kubectl version --client -o json 2>/dev/null | grep -Eq '"gitVersion"[[:space:]]*:[[:space:]]*"v1\.35\.1"'; then kubectl_ready=true; fi
if "$mysql_ready" && "$glab_ready" && "$lark_ready" && "$meegle_ready" && "$kubectl_ready" && command -v git >/dev/null; then
  echo 'Command tools already installed'
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
if ! "$mysql_ready" || ! command -v curl >/dev/null || ! command -v git >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git
fi
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
if ! "$mysql_ready"; then
  mysql_packages=()
  while read -r package checksum; do
    file="$work_dir/${package}_${mysql_version}_amd64.deb"
    curl -fL --retry 3 --retry-all-errors "https://repo.mysql.com/apt/debian/pool/mysql-8.0/m/mysql-community/${package}_${mysql_version}_amd64.deb" -o "$file"
    printf '%s  %s\n' "$checksum" "$file" | sha256sum -c -
    mysql_packages+=("$file")
  done <<'PACKAGES'
mysql-common aa39aea5041b34fa525624167022888a31e42aeea54929f3a7b688f875801536
mysql-community-client-plugins fd6704020d38a1089868aece1b835e0f62e2c9df7dd06c57bed0ef305a48668f
mysql-community-client-core 9c7e3064709b537c9acb64ffb17c491e764a766526705dedca81cd7ecf249a3e
mysql-community-client 4d89cd19067b0a864614410c76f8fb11af044c63bd04d50ce61feb5ac9b14bbe
PACKAGES
  apt-get install -y --no-install-recommends "${mysql_packages[@]}"
  rm -f "${mysql_packages[@]}"
fi
if ! "$glab_ready"; then
  curl -fL --retry 3 --retry-all-errors "https://gitlab.com/gitlab-org/cli/-/releases/v${glab_version}/downloads/glab_${glab_version}_linux_amd64.tar.gz" -o "$work_dir/glab.tar.gz"
  printf '%s  %s\n' '173cc61ea94c562f2ccd831f320d25b73982192e82810064552282482e3713ea' "$work_dir/glab.tar.gz" | sha256sum -c -
  tar -xzf "$work_dir/glab.tar.gz" -C "$work_dir"
  install -m 0755 "$work_dir/bin/glab" /usr/local/bin/glab
  rm -rf "$work_dir/bin" "$work_dir/glab.tar.gz"
fi
rm -rf /var/lib/apt/lists/*
# Both npm packages wrap static Go binaries. Install just the Linux executable:
# no npm tree or extra Node interpreter, and project mise versions cannot affect it.
if ! "$lark_ready"; then
  curl -fL --retry 3 --retry-all-errors "https://github.com/larksuite/cli/releases/download/v${lark_version}/lark-cli-${lark_version}-linux-amd64.tar.gz" -o "$work_dir/lark.tar.gz"
  printf '%s  %s\n' 'a07a603d29ed58e8b5b0d7395cae10dfabed2b860be31b7134f8bf39705e7cff' "$work_dir/lark.tar.gz" | sha256sum -c -
  tar -xzf "$work_dir/lark.tar.gz" -C "$work_dir" lark-cli
  chmod 0755 "$work_dir/lark-cli"
  mv -f "$work_dir/lark-cli" /usr/local/bin/lark-cli
  rm -f "$work_dir/lark.tar.gz"
fi
if ! "$meegle_ready"; then
  curl -fL --retry 3 --retry-all-errors "https://registry.npmjs.org/@lark-project/meegle/-/meegle-${meegle_version}.tgz" -o "$work_dir/meegle.tgz"
  # Fixed SHA512 from the official npm dist.integrity for @lark-project/meegle@1.0.20.
  printf '%s  %s\n' '1238e0088c6a9cd2fe06db73c905362d4021147bf4b43ecde7a7ab00a520df552a10e06316f51bae990695796bd5073777d66dee907743d05af29d4e6b527cbf' "$work_dir/meegle.tgz" | sha512sum -c -
  tar -xzf "$work_dir/meegle.tgz" -C "$work_dir" package/bin/meegle-linux-x64
  chmod 0755 "$work_dir/package/bin/meegle-linux-x64"
  mv -f "$work_dir/package/bin/meegle-linux-x64" /usr/local/bin/meegle
  rm -rf "$work_dir/package" "$work_dir/meegle.tgz"
fi
if ! "$kubectl_ready"; then
  # Official binary is 58,597,560 bytes. Fail clearly on old tiny root disks;
  # a standard installation needs no launcher, Node runtime or shared-memory cache.
  available_kib=$(df -Pk /usr/local/bin | awk 'NR == 2 {print $4}')
  if (( available_kib < 62 * 1024 )); then
    echo 'kubectl v1.35.1 requires at least 62 MiB free for installation; this sandbox needs more free disk space.' >&2
    exit 1
  fi
  curl -fL --retry 3 --retry-all-errors "https://dl.k8s.io/release/${kubectl_version}/bin/linux/amd64/kubectl" -o "$work_dir/kubectl"
  # https://dl.k8s.io/release/v1.35.1/bin/linux/amd64/kubectl.sha256
  printf '%s  %s\n' '36e2f4ac66259232341dd7866952d64a958846470f6a9a6a813b9117bd965207' "$work_dir/kubectl" | sha256sum -c -
  chmod 0755 "$work_dir/kubectl"
  mv -f "$work_dir/kubectl" /usr/local/bin/kubectl
fi
git --version
glab --version
mysql --version
mysql_config_editor --version
lark-cli --version
meegle --version
kubectl version --client -o json
# Exercise only help: never connect to a database or read a login-path here.
mysql --no-defaults --help | grep -F -- '--login-path'
glab auth git-credential --help >/dev/null
lark-cli docs --help >/dev/null
lark-cli drive +list-comments --help >/dev/null
lark-cli drive +add-comment --help >/dev/null
# Business command metadata is downloaded after authentication. A clean public
# template can validate the CLI itself; project/workitem help is checked after
# the application's separate credential synchronization.
meegle --help >/dev/null
meegle inspect --help >/dev/null
