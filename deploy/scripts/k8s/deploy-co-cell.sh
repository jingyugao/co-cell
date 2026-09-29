#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

registry_endpoint="${COCELL_REGISTRY_ENDPOINT:-http://192.168.133.1:5001}"
if [[ ! "$registry_endpoint" =~ ^http://[^/]+$ ]]; then
  echo "COCELL_REGISTRY_ENDPOINT must be an HTTP registry origin" >&2
  exit 2
fi
registry_host="${registry_endpoint#http://}"
image_repository="${COCELL_IMAGE_REPOSITORY:-${registry_host}/co-cell}"
if [[ "$image_repository" != "${registry_host}/"* ]]; then
  echo "CoCell image repository must be on ${registry_host}" >&2
  exit 2
fi
image_tag="${COCELL_IMAGE_TAG:-}"
values_file="${COCELL_HELM_VALUES:-deploy/local/co-cell.values.yaml}"
kube_context="${COCELL_KUBE_CONTEXT:-k3s}"
namespace="${COCELL_NAMESPACE:-co-cell}"
release="${COCELL_HELM_RELEASE:-co-cell}"
chart="${COCELL_HELM_CHART:-./deploy/helm/co-cell}"

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [IMAGE_TAG]" >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  image_tag="$1"
fi
if [[ -z "$image_tag" ]]; then
  git_sha="$(git rev-parse --short=12 HEAD)"
  image_tag="k8s-$(date -u +%Y%m%d-%H%M%S)-${git_sha}"
fi

for command in curl docker helm git kubectl skopeo; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command not found: $command" >&2
    exit 1
  fi
done
if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 3 --max-time 8 "${registry_endpoint}/v2/")" != 200 ]]; then
  echo "Docker registry is unavailable at ${registry_endpoint}" >&2
  exit 1
fi
if ! docker image inspect node:22.18.0-bookworm-slim >/dev/null 2>&1; then
  echo "Node 22.18.0 base image must be loaded locally before deploying; refusing a Docker Hub pull" >&2
  exit 1
fi
values_args=()
if [[ -f "$values_file" ]]; then
  values_args=(--values "$values_file")
elif [[ -n "${COCELL_HELM_VALUES:-}" ]]; then
  echo "Helm values file not found: $values_file" >&2
  exit 1
elif helm status "$release" --kube-context "$kube_context" --namespace "$namespace" >/dev/null 2>&1; then
  echo "Using values from the existing Helm release ${release}"
  values_args=(--reuse-values)
else
  echo "Create deploy/local/co-cell.values.yaml from deploy/helm/co-cell/values-k3s.example.yaml before the first install." >&2
  exit 1
fi
preview_args=()
if [[ -n "${COCELL_PREVIEW_SUBDOMAINS:-}" ]]; then
  case "$COCELL_PREVIEW_SUBDOMAINS" in
    0) preview_args=(--set ingress.previewSubdomains=false) ;;
    1) preview_args=(--set ingress.previewSubdomains=true) ;;
    *) echo "COCELL_PREVIEW_SUBDOMAINS must be 0 or 1" >&2; exit 2 ;;
  esac
fi
if [[ ! -d "$chart" ]]; then
  echo "Helm chart not found: $chart" >&2
  exit 1
fi

image="${image_repository}:${image_tag}"
echo "Building ${image} for linux/amd64 with the local Docker cache"
docker build --platform linux/amd64 --file "$repo_root/deploy/web/Dockerfile" --tag "$image" .
image_archive="$(mktemp --suffix=.tar)"
trap 'rm -f "$image_archive"' EXIT
docker save --output "$image_archive" "$image"
echo "Publishing ${image} to ${registry_endpoint}"
skopeo copy --dest-tls-verify=false "docker-archive:${image_archive}" "docker://${image}"

echo "Upgrading Helm release ${release} in ${namespace}"
helm upgrade "$release" "$chart" \
  --kube-context "$kube_context" \
  --namespace "$namespace" \
  "${values_args[@]}" \
  "${preview_args[@]}" \
  --set-string "image.repository=${image_repository}" \
  --set-string "image.tag=${image_tag}" \
  --set-string image.digest= \
  --atomic \
  --wait \
  --timeout 5m

kubectl --context "$kube_context" --namespace "$namespace" rollout status "deployment/${release}" --timeout=5m
echo "Deployed ${image}"
