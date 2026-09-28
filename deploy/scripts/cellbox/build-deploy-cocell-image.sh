#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ $# -ne 1 ]]; then
  echo "usage: COCELL_REGISTRY_ENDPOINT=http://HOST:PORT $0 CELLBOX_SOURCE_DIR" >&2
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
namespace="${COCELL_NAMESPACE:-co-cell}"
config_secret="${COCELL_CELLBOX_CONFIG_SECRET:-cellbox-api-config}"
api_deployment="${COCELL_CELLBOX_API_DEPLOYMENT:-cellbox-api}"
profile_id="${COCELL_CELLBOX_PROFILE:-cocell-k8s-resumable}"

for command in curl docker jq kubectl python3 skopeo; do
  command -v "$command" >/dev/null 2>&1 || { echo "required command not found: $command" >&2; exit 1; }
done
if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 3 --max-time 8 "${registry_endpoint}/v2/")" != 200 ]]; then
  echo "Docker registry is unavailable at ${registry_endpoint}" >&2
  exit 1
fi
if ! kubectl --context "$kube_context" get crd resumablepods.recovery.gvisor.dev -o json |
  jq -e '.spec.versions[] | select(.name == "v1alpha1") | .schema.openAPIV3Schema.properties.spec.properties.container.properties.imagePullPolicy.enum | index("IfNotPresent")' >/dev/null; then
  echo "Cellbox must support IfNotPresent before deploying a registry image" >&2
  exit 1
fi

build_result="$("$repo_root/deploy/scripts/cellbox/build-cocell-image.sh" "$1")"
prepared_tag="$(jq -er '.tag' <<< "$build_result")"
image_key="$(jq -er '.key' <<< "$build_result")"
if [[ ! "$image_key" =~ ^[a-f0-9]{64}$ || "$prepared_tag" != "cellbox-prepared:${image_key}" ]]; then
  echo "Cellbox image builder returned an invalid image identity" >&2
  exit 1
fi
manifest_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --head \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  "${registry_endpoint}/v2/${image_repository#${registry_host}/}/manifests/${image_tag}")"
case "$manifest_status" in
  200)
    remote_image="$(skopeo inspect --tls-verify=false "docker://${image}")"
    remote_key="$(jq -r '.Labels["cellbox.image-key"] // empty' <<< "$remote_image")"
    if [[ "$remote_key" != "$image_key" ]]; then
      echo "${image} already exists with different content; choose a new version" >&2
      exit 1
    fi
    echo "Reusing ${image} (same Cellbox image key)"
    digest="$(jq -er '.Digest' <<< "$remote_image")"
    ;;
  404)
    echo "Publishing ${prepared_tag} to ${image}"
    image_archive="$(mktemp --suffix=.tar)"
    trap 'rm -f "$image_archive"' EXIT
    docker save --output "$image_archive" "$prepared_tag"
    skopeo copy --dest-tls-verify=false "docker-archive:${image_archive}" "docker://${image}"
    digest="$(skopeo inspect --tls-verify=false "docker://${image}" | jq -er '.Digest')"
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
immutable_image="${image}@${digest}"

profile_patch="$(kubectl --context "$kube_context" --namespace "$namespace" get secret "$config_secret" -o json |
  COCELL_DEBUG_READ_ONLY_HOST_PATH="${COCELL_DEBUG_READ_ONLY_HOST_PATH:-}" \
  COCELL_DEBUG_READ_WRITE_HOST_PATH="${COCELL_DEBUG_READ_WRITE_HOST_PATH:-}" \
  COCELL_DEBUG_HOST_UID="${COCELL_DEBUG_HOST_UID:-}" COCELL_DEBUG_HOST_GID="${COCELL_DEBUG_HOST_GID:-}" \
  python3 "$repo_root/deploy/scripts/cellbox/patch-cocell-profile.py" "$profile_id" "$immutable_image" "$repo_root/cellbox/cocell/profile.sample.json")"
if [[ "$profile_patch" == "[]" ]]; then
  echo "Cellbox profile ${profile_id} already uses ${immutable_image} and the admitted tools"
  exit 0
fi

echo "Updating Cellbox profile ${profile_id} to ${immutable_image} with admitted tools"
printf '%s' "$profile_patch" |
  kubectl --context "$kube_context" --namespace "$namespace" patch secret "$config_secret" --type=json --patch-file=/dev/stdin >/dev/null

kubectl --context "$kube_context" --namespace "$namespace" rollout restart "deployment/${api_deployment}"
kubectl --context "$kube_context" --namespace "$namespace" rollout status "deployment/${api_deployment}" --timeout=5m
echo "Deployed ${immutable_image} for new Cellbox Sandboxes"
