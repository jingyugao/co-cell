#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_OS:-} == Linux ]] || { echo 'Only run on a disposable GitHub Linux runner' >&2; exit 2; }
[[ ! -e /etc/rancher/k3s/k3s.yaml ]] || { echo 'Refusing to change an existing cluster' >&2; exit 2; }
test -n "${GITHUB_RUN_ID:?}"
for command in curl tar sha512sum make docker helm aws kubectl; do
  command -v "$command" >/dev/null || { echo "Missing CI prerequisite: $command" >&2; exit 2; }
done
work="${RUNNER_TEMP:?}/cocell-ci"
mkdir -p "$work"
chmod 700 "$work"

# Fixed versions: containerd 2.x uses the v3 runtime template below.
k3s_version='v1.34.1+k3s1'
gvisor_version='20260914.0'
curl -fsSL "https://raw.githubusercontent.com/k3s-io/k3s/${k3s_version}/install.sh" -o "$work/install-k3s.sh"
sudo env INSTALL_K3S_VERSION="$k3s_version" sh "$work/install-k3s.sh" server --disable=traefik --disable=servicelb --disable=metrics-server
mkdir -p "$HOME/.kube"
sudo cp /etc/rancher/k3s/k3s.yaml "$work/kubeconfig"
sudo chown "$(id -u):$(id -g)" "$work/kubeconfig"
chmod 600 "$work/kubeconfig"
export KUBECONFIG="$work/kubeconfig"
kubectl config rename-context default cocell-ci
printf 'KUBECONFIG=%s\n' "$KUBECONFIG" >> "$GITHUB_ENV"
kubectl --context cocell-ci wait --for=condition=Ready node --all --timeout=180s
kubectl --context cocell-ci label node --all "cocell-ci-run=$GITHUB_RUN_ID"

url="https://storage.googleapis.com/gvisor/releases/release/$gvisor_version/x86_64"
curl -fsSL "$url/gvisor.tar.bz2" -o "$work/gvisor.tar.bz2"
curl -fsSL "$url/gvisor.tar.bz2.sha512" -o "$work/gvisor.tar.bz2.sha512"
(cd "$work" && sha512sum -c gvisor.tar.bz2.sha512)
mkdir "$work/gvisor"
tar -xjf "$work/gvisor.tar.bz2" -C "$work/gvisor"
test -x "$work/gvisor/gvisor-bin/gvisor_sentry"
sudo cp -a "$work/gvisor/gvisor-bin" /usr/local/bin/
sudo install -m 755 "$work/gvisor/runsc" "$work/gvisor/containerd-shim-runsc-v1" /usr/local/bin/
make -C "$CELLBOX_SOURCE_DIR" build
sudo install -D -m 755 "$CELLBOX_SOURCE_DIR/dist/release/cellbox-runsc-wrapper" /usr/local/libexec/cellbox-runsc-wrapper
sudo install -d -m 700 /var/lib/cellbox /var/lib/cellbox/tickets /var/lib/cellbox/requests /var/lib/cellbox/claims /var/lib/cellbox/workloads /var/lib/cellbox/logs
cat > "$work/runsc.toml" <<'EOF'
binary_name = "/usr/local/libexec/cellbox-runsc-wrapper"
log_path = "/var/lib/cellbox/logs/%ID%/shim.log"
log_level = "info"
[runsc_config]
  restore-spec-validation = "enforce"
  platform = "systrap"
EOF
sudo install -m 600 "$work/runsc.toml" /var/lib/cellbox/runsc.toml
cat > "$work/containerd.tmpl" <<'EOF'
{{ template "base" . }}
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runsc-recoverable]
  runtime_type = "io.containerd.runsc.v1"
  pod_annotations = ["dev.gvisor.internal.recovery.ticket"]
  [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runsc-recoverable.options]
    TypeUrl = "io.containerd.runsc.v1.options"
    ConfigPath = "/var/lib/cellbox/runsc.toml"
EOF
sudo install -m 600 "$work/containerd.tmpl" /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl
sudo systemctl restart k3s
# The API socket closes during the expected service restart. Wait for startup
# before watching node readiness; do not retry deployments or test assertions.
deadline=$((SECONDS + 180))
until kubectl --context cocell-ci get --raw=/readyz >/dev/null 2>&1; do
  (( SECONDS < deadline )) || { echo 'K3s API did not restart' >&2; exit 1; }
  sleep 2
done
kubectl --context cocell-ci wait --for=condition=Ready node --all --timeout=180s
runsc --version
