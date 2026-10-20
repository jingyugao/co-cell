#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_OS:-} == Linux ]] || { echo 'Only run on a disposable GitHub Linux runner' >&2; exit 2; }
[[ ! -e /etc/rancher/k3s/k3s.yaml ]] || { echo 'Refusing to change an existing cluster' >&2; exit 2; }
test -n "${GITHUB_RUN_ID:?}"
for command in curl make docker helm aws kubectl; do
  command -v "$command" >/dev/null || { echo "Missing CI prerequisite: $command" >&2; exit 2; }
done
work="${RUNNER_TEMP:?}/cocell-ci"
mkdir -p "$work"
chmod 700 "$work"

gvisor_commit='fe674565335026d0b688291941f4d5fcbb542b6d'
gvisor_source="${COCELL_GVISOR_SOURCE_DIR:?}"
gvisor_release="${COCELL_GVISOR_RELEASE_DIR:?}"
[[ "$(git -C "$gvisor_source" rev-parse HEAD)" == "$gvisor_commit" ]] || {
  echo 'gVisor source does not match the pinned CoCell fork revision' >&2
  exit 1
}
test -x "$gvisor_release/runsc"
test -x "$gvisor_release/containerd-shim-runsc-v1"
test -x "$gvisor_release/gvisor-bin/gvisor_sentry"
test -x "$gvisor_release/gvisor-bin/checkpointgofer"
gvisor_install="/usr/local/lib/cellbox/gvisor/$gvisor_commit"
sudo install -d -m 755 "$gvisor_install"
sudo install -m 755 "$gvisor_release/runsc" "$gvisor_release/containerd-shim-runsc-v1" "$gvisor_install/"
sudo install -d -m 755 "$gvisor_install/gvisor-bin"
sudo cp -a "$gvisor_release/gvisor-bin/." "$gvisor_install/gvisor-bin/"
sudo install -d -m 755 /usr/local/libexec
cat > "$work/cellbox-runsc-launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export CELLBOX_RUNSC="$gvisor_install/runsc"
exec /usr/local/libexec/cellbox-runsc-wrapper "\$@"
EOF
sudo install -m 755 "$work/cellbox-runsc-launcher" /usr/local/libexec/cellbox-runsc-launcher
printf 'COCELL_CI_RUNSC=%s\n' "$gvisor_install/runsc" >> "$GITHUB_ENV"
printf 'COCELL_CI_SHIM=%s\n' "$gvisor_install/containerd-shim-runsc-v1" >> "$GITHUB_ENV"

# Fixed versions: containerd 2.x uses the v3 runtime template below.
k3s_version='v1.34.1+k3s1'
curl -fsSL "https://raw.githubusercontent.com/k3s-io/k3s/${k3s_version}/install.sh" -o "$work/install-k3s.sh"
sudo env INSTALL_K3S_VERSION="$k3s_version" sh "$work/install-k3s.sh" server --disable=traefik --disable=servicelb --disable=metrics-server
node_ip="$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == "src") {print $(i+1); exit}}')"
[[ "$node_ip" =~ ^[0-9.]+$ ]] || { echo 'Cannot determine the disposable CI node IPv4 address' >&2; exit 1; }
printf 'COCELL_CI_NODE_IP=%s\n' "$node_ip" >> "$GITHUB_ENV"
sudo install -d -m 755 /etc/rancher/k3s
sudo tee /etc/rancher/k3s/registries.yaml >/dev/null <<EOF
mirrors:
  "${node_ip}:5000":
    endpoint:
      - "http://${node_ip}:5000"
EOF
mkdir -p "$HOME/.kube"
sudo cp /etc/rancher/k3s/k3s.yaml "$work/kubeconfig"
sudo chown "$(id -u):$(id -g)" "$work/kubeconfig"
chmod 600 "$work/kubeconfig"
export KUBECONFIG="$work/kubeconfig"
kubectl config rename-context default cocell-ci
printf 'KUBECONFIG=%s\n' "$KUBECONFIG" >> "$GITHUB_ENV"
kubectl --context cocell-ci wait --for=condition=Ready node --all --timeout=180s
kubectl --context cocell-ci label node --all "cocell-ci-run=$GITHUB_RUN_ID"

make -C "$CELLBOX_SOURCE_DIR" build
sudo install -D -m 755 "$CELLBOX_SOURCE_DIR/dist/release/cellbox-runsc-wrapper" /usr/local/libexec/cellbox-runsc-wrapper
sudo install -d -m 700 /var/lib/cellbox /var/lib/cellbox/tickets /var/lib/cellbox/requests /var/lib/cellbox/claims /var/lib/cellbox/workloads /var/lib/cellbox/logs
cat > "$work/runsc.toml" <<'EOF'
binary_name = "/usr/local/libexec/cellbox-runsc-launcher"
log_path = "/var/lib/cellbox/logs/%ID%/shim.log"
log_level = "info"
[runsc_config]
  restore-spec-validation = "enforce"
  platform = "systrap"
  overlay2 = "root:memory"
EOF
sudo install -m 600 "$work/runsc.toml" /var/lib/cellbox/runsc.toml
cat > "$work/containerd.tmpl" <<EOF
{{ template "base" . }}
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runsc-recoverable]
  runtime_type = "io.containerd.runsc.v1"
  runtime_path = "$gvisor_install/containerd-shim-runsc-v1"
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
"$gvisor_install/runsc" --version
