#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SANDBOX_IMAGE:-cellbox:latest}"
ID="${GVISOR_TEST_ID:-swarm-hive-gvisor-smoke}"
RUNSC="${GVISOR_RUNSC:-/usr/local/bin/runsc}"
ROOT="${GVISOR_ROOT:-/var/run/runsc}"
BASE="$(mktemp -d /tmp/swarm-hive-gvisor-smoke.XXXXXX)"
BUNDLE="$BASE/bundle"
CHECKPOINTS="$BASE/checkpoints"

cleanup() {
  sudo "$RUNSC" -platform=ptrace -root="$ROOT" delete -force "$ID" >/dev/null 2>&1 || true
  rm -rf "$BASE"
}
trap cleanup EXIT

echo "[1/6] Exporting image: $IMAGE"
SANDBOX_BUNDLE_TEST="$BASE" SANDBOX_IMAGE="$IMAGE" GVISOR_TEST_ID="$ID" pnpm exec tsx -e "import { DockerSandboxImageManager } from './packages/sandbox/src/image/docker.ts'; void (async()=>{ const m=new DockerSandboxImageManager(process.env.SANDBOX_BUNDLE_TEST!); await m.prepareBundle(await m.inspect(process.env.SANDBOX_IMAGE!), process.env.GVISOR_TEST_ID!); })().catch(e=>{ console.error(e); process.exit(1); });"
mv "$BASE/bundles/$ID" "$BUNDLE"
mkdir -p "$CHECKPOINTS"

echo "[2/6] Creating and starting gVisor sandbox"
sudo "$RUNSC" -platform=ptrace -root="$ROOT" create --bundle "$BUNDLE" "$ID"
sudo "$RUNSC" -platform=ptrace -root="$ROOT" start "$ID"
sudo "$RUNSC" -platform=ptrace -root="$ROOT" exec "$ID" uname -a

echo "[3/6] Checkpointing"
sudo "$RUNSC" -platform=ptrace -root="$ROOT" checkpoint \
  -image-path="$CHECKPOINTS" -leave-running=false "$ID"
test -s "$CHECKPOINTS/checkpoint.img"

echo "[4/6] Restoring"
sudo "$RUNSC" -platform=ptrace -root="$ROOT" delete "$ID"
(cd "$BUNDLE" && sudo "$RUNSC" -platform=ptrace -root="$ROOT" restore \
  -image-path="$CHECKPOINTS" "$ID") &
restore_pid=$!
sleep 3
sudo "$RUNSC" -platform=ptrace -root="$ROOT" state "$ID"
# restore remains attached to the restored init process. Waiting here would
# therefore block forever for the sandbox image's long-lived App Server.
disown "$restore_pid" 2>/dev/null || true

echo "[5/6] Verifying restored execution"
restored=$(sudo "$RUNSC" -platform=ptrace -root="$ROOT" exec "$ID" uname -a)
echo "$restored"
grep -q 'gvisor' <<<"$restored"

echo "[6/6] PASS: gVisor checkpoint/restore succeeded"
