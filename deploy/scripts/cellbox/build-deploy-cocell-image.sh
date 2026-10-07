#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ $# -ne 0 ]]; then
  echo "usage: COCELL_REGISTRY_ENDPOINT=http://HOST:PORT $0" >&2
  exit 2
fi
if [[ -n "${COCELL_DEBUG_READ_ONLY_HOST_PATH:-}" && -n "${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}" ]]; then
  echo "Configure only one debug host mount mode" >&2
  exit 2
fi
if [[ -n "${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}" && ( -z "${COCELL_DEBUG_HOST_UID:-}" || -z "${COCELL_DEBUG_HOST_GID:-}" ) ]]; then
  echo "Set COCELL_DEBUG_HOST_UID and COCELL_DEBUG_HOST_GID for the writable host mount" >&2
  exit 2
fi

registry_endpoint="${COCELL_REGISTRY_ENDPOINT:?Set COCELL_REGISTRY_ENDPOINT to the local HTTP registry origin}"
if [[ ! "$registry_endpoint" =~ ^http://[^/]+$ ]]; then
  echo "COCELL_REGISTRY_ENDPOINT must be an HTTP registry origin" >&2
  exit 2
fi
registry_host="${registry_endpoint#http://}"
image_repository="${COCELL_SANDBOX_IMAGE_REPOSITORY:-${registry_host}/cellbox-cocell-sandbox}"
if [[ "$image_repository" != "${registry_host}/"* ]]; then
  echo "Sandbox image repository must be on ${registry_host}" >&2
  exit 2
fi
image_tag="${COCELL_SANDBOX_IMAGE_TAG:-v0.0.1}"
if [[ ! "$image_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "COCELL_SANDBOX_IMAGE_TAG must use vMAJOR.MINOR.PATCH, for example v0.0.1" >&2
  exit 2
fi
image="${image_repository}:${image_tag}"

kube_context="${COCELL_KUBE_CONTEXT:-k3s}"
namespace="${COCELL_CELLBOX_NAMESPACE:-cell-box}"
release="${COCELL_CELLBOX_RELEASE:-cellbox}"
cellbox_source="${CELLBOX_SOURCE_DIR:?Set CELLBOX_SOURCE_DIR to the Cellbox source directory}"
profile_id="${COCELL_CELLBOX_PROFILE:-cocell-k8s-resumable}"
shared_enabled="$(uv run --no-project python "$repo_root/deploy/scripts/cellbox/mount_config.py")"

for command in curl jq kubectl uv helm docker; do
  command -v "$command" >/dev/null 2>&1 || { echo "required command not found: $command" >&2; exit 1; }
done
if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 3 --max-time 8 "${registry_endpoint}/v2/")" != 200 ]]; then
  echo "Docker registry is unavailable at ${registry_endpoint}" >&2
  exit 1
fi
if ! kubectl --context "$kube_context" get crd cellboxes.cellbox.local -o json |
  jq -e '.spec.versions[] | select(.name == "v1alpha1") | .schema.openAPIV3Schema.properties.spec.properties.container.properties.imagePullPolicy.enum | index("IfNotPresent")' >/dev/null; then
  echo "Cellbox must support IfNotPresent before deploying a registry image" >&2
  exit 1
fi

manifest_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --head \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' \
  "${registry_endpoint}/v2/${image_repository#${registry_host}/}/manifests/${image_tag}")"
case "$manifest_status" in
  200)
    manifest="$(curl --fail --silent --show-error --header 'Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' \
      "${registry_endpoint}/v2/${image_repository#${registry_host}/}/manifests/${image_tag}")"
    config_digest="$(jq -er '.config.digest' <<< "$manifest")"
    remote_config="$(curl --fail --silent --show-error "${registry_endpoint}/v2/${image_repository#${registry_host}/}/blobs/${config_digest}")"
    remote_key="$(jq -r '.config.Labels["cellbox.image-key"] // empty' <<< "$remote_config")"
    remote_version="$(jq -r '.config.Labels["cellbox.managed-image"] // empty' <<< "$remote_config")"
    if [[ "$remote_version" != "2" || ! "$remote_key" =~ ^[a-f0-9]{64}$ ]]; then
      echo "${image} is not a Cellbox prepared image" >&2
      exit 1
    fi
    digest="$(curl --fail --silent --show-error --head \
      --header 'Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' \
      "${registry_endpoint}/v2/${image_repository#${registry_host}/}/manifests/${image_tag}" \
      | awk -F': ' 'tolower($1) == "docker-content-digest" {print $2}' | tr -d '\r')"
    ;;
  404)
    echo "Prepared Cellbox sandbox image ${image} is missing; publish it before deploying" >&2
    exit 1
    ;;
  *)
    echo "Cannot check ${image}: registry returned HTTP ${manifest_status}" >&2
    exit 1
    ;;
esac
if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "Registry returned an invalid image digest" >&2
  exit 1
fi
immutable_image="${image_repository}@${digest}"
if [[ "$shared_enabled" == 1 ]]; then
  kubectl --context "$kube_context" get crd cellboxes.cellbox.local -o json |
    jq -e '.spec.versions[] | select(.name == "v1alpha1") | .schema.openAPIV3Schema.properties.spec.properties.sharedReadOnlyHostPath' >/dev/null || {
      echo "Deploy the Cellbox controller/CRD with sharedReadOnlyHostPath support first" >&2
      exit 1
    }
fi

profile_patch="$(helm get values "$release" --kube-context "$kube_context" --namespace "$namespace" --all --output json |
  COCELL_DEBUG_READ_ONLY_HOST_PATH="${COCELL_DEBUG_READ_ONLY_HOST_PATH:-}" \
  COCELL_DEBUG_READ_WRITE_HOST_PATH="${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}" \
  COCELL_DEBUG_HOST_UID="${COCELL_DEBUG_HOST_UID:-}" COCELL_DEBUG_HOST_GID="${COCELL_DEBUG_HOST_GID:-}" \
  COCELL_TOOL_RUNTIME_MOUNT_VERSION="$(jq -r '.config.Labels["cocell.tool-runtime-mount"] // empty' <<< "$remote_config")" \
  COCELL_DEBUG_HOME_VERSION="$(jq -r '.config.Labels["cocell.debug-home"] // empty' <<< "$remote_config")" \
  uv run --no-project python "$repo_root/deploy/scripts/cellbox/patch-cocell-profile.py" "$profile_id" "$immutable_image" "$repo_root/deploy/box-wrap/profile.sample.json")"
if [[ "$profile_patch" == "{}" ]]; then
  echo "Cellbox profile ${profile_id} already uses ${immutable_image} and the admitted tools"
  exit 0
fi

echo "Updating Cellbox profile ${profile_id} to ${immutable_image} with admitted tools"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
chmod 700 "$work"
printf '%s' "$profile_patch" > "$work/profile.json"
chmod 600 "$work/profile.json"
helm upgrade "$release" "$cellbox_source/charts/cellbox" \
  --kube-context "$kube_context" --namespace "$namespace" --reuse-values \
  --values "$work/profile.json" --wait --timeout 10m
echo "Deployed ${immutable_image} for new Cellbox Sandboxes"
