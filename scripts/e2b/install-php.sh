#!/usr/bin/env bash
set -euo pipefail
# Public runtime only. No application source, credentials or service startup.
manifest=/opt/codex-template/toolchains.json
field() { node -e 'let v=require(process.argv[1]); for(const k of process.argv[2].split("."))v=v?.[k]; if(v!==undefined)process.stdout.write(String(v))' "$manifest" "$1"; }
php_version=$(field php.version)
[[ -n "$php_version" ]] || { echo 'PHP runtime disabled'; exit 0; }
[[ "$php_version" == 8.0.30 ]] || { echo 'Unsupported PHP runtime version' >&2; exit 1; }
[[ $(id -u) == 0 ]] || { echo 'PHP installation requires root' >&2; exit 1; }
. /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 12 ]] || { echo 'PHP runtime requires Debian 12' >&2; exit 1; }
composer_version=$(field php.composer.version)
composer_sha=$(field php.composer.sha256)
[[ "$composer_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$composer_sha" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid Composer pin' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl
# Repository owner's signed apt repository, following its published README.
curl -fL --retry 3 --retry-all-errors https://packages.sury.org/debsuryorg-archive-keyring.deb -o "$work_dir/keyring.deb"
dpkg -i "$work_dir/keyring.deb"
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ bookworm main' > /etc/apt/sources.list.d/codex-php.list
apt-get update
apt-get install -y --no-install-recommends \
  php8.0-cli php8.0-common php8.0-curl php8.0-mbstring php8.0-mysql \
  php8.0-bcmath php8.0-gd php8.0-zip php8.0-xml php8.0-sqlite3 \
  php8.0-redis php8.0-yaml
update-alternatives --set php /usr/bin/php8.0
[[ $(php -r 'echo PHP_VERSION;') == "$php_version" ]] || { echo 'PHP package version mismatch' >&2; exit 1; }
curl -fL --retry 3 --retry-all-errors "https://getcomposer.org/download/${composer_version}/composer.phar" -o "$work_dir/composer"
printf '%s  %s\n' "$composer_sha" "$work_dir/composer" | sha256sum -c -
install -m 0755 "$work_dir/composer" /usr/local/bin/composer
php -r '$required=explode(",", "bcmath,ctype,curl,dom,fileinfo,gd,iconv,json,libxml,mbstring,mysqli,openssl,pcntl,pdo,pdo_mysql,posix,redis,SimpleXML,sockets,xml,xmlreader,xmlwriter,yaml,zip,zlib"); foreach($required as $ext) { if(!extension_loaded($ext)) {fwrite(STDERR,"Missing PHP extension: $ext\n"); exit(1);} }'
# Record exact distro package revisions; upstream PHP pin does not pin apt revisions.
dpkg-query -W -f='${Package}\t${Version}\n' 'php8.0*' > /opt/codex-template/php-packages.txt
php --version
composer --no-plugins --no-scripts --version
apt-get clean
rm -rf /var/lib/apt/lists/*
