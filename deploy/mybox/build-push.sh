#!/usr/bin/env bash
set -euo pipefail

# Build and publish the MyBox base image. The version file is deliberately
# local: deploy/mybox is ignored because its package cache and credentials are
# installation-specific.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
registry_endpoint="${MYBOX_REGISTRY_ENDPOINT:-http://192.168.133.1:5001}"
registry_host="${registry_endpoint#http://}"
repository="${MYBOX_IMAGE_REPOSITORY:-${registry_host}/mybox}"
version_file="${MYBOX_VERSION_FILE:-$root/current-version}"

if [[ ! "$registry_endpoint" =~ ^http://[^/]+$ ]]; then
  echo "MYBOX_REGISTRY_ENDPOINT must be an HTTP registry origin" >&2
  exit 2
fi
if [[ "$repository" != "${registry_host}/"* ]]; then
  echo "MYBOX_IMAGE_REPOSITORY must use the registry host ${registry_host}" >&2
  exit 2
fi
for command in curl docker; do
  command -v "$command" >/dev/null 2>&1 || { echo "required command not found: $command" >&2; exit 1; }
done
if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 3 --max-time 8 "$registry_endpoint/v2/")" != 200 ]]; then
  echo "Docker registry is unavailable at $registry_endpoint" >&2
  exit 1
fi

current="1.0.0"
if [[ -f "$version_file" ]]; then
  current="$(tr -d '[:space:]' < "$version_file")"
fi
if [[ ! "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "Invalid version in $version_file: $current" >&2
  exit 2
fi
major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
version="$major.$minor.$((patch + 1))"
image="$repository:$version"

echo "Building $image"
docker build --file "$root/Dockerfile" --tag "$image" "$root"
echo "Publishing $image to $registry_endpoint"
docker push "$image"
printf '%s\n' "$version" > "$version_file"
echo "Published $image"
