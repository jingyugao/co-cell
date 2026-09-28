#!/usr/bin/env python3
"""Build, publish, and roll out the node-local ResumablePod controller."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


def kube(*args: str) -> tuple[str, ...]:
    return ("kubectl", "--context", context, "--namespace", namespace, *args)


if len(sys.argv) != 2:
    raise SystemExit("usage: deploy-cellbox-controller.py CELLBOX_SOURCE_DIR")
source = Path(sys.argv[1]).expanduser().resolve()
endpoint = os.environ.get("COCELL_REGISTRY_ENDPOINT", "")
if not endpoint.startswith("http://") or "/" in endpoint[7:]:
    raise SystemExit("Set COCELL_REGISTRY_ENDPOINT to an HTTP registry origin")
host = endpoint[7:]
repository = os.environ.get("COCELL_CELLBOX_CONTROLLER_IMAGE_REPOSITORY", f"{host}/resumablepod-controller")
if not repository.startswith(host + "/"):
    raise SystemExit(f"Controller image repository must be on {host}")
context = os.environ.get("COCELL_KUBE_CONTEXT", "k3s")
namespace = os.environ.get("COCELL_CONTROLLER_NAMESPACE", "cell-box")
daemonset = os.environ.get("COCELL_CONTROLLER_DAEMONSET", "resumablepod-controller")
container = os.environ.get("COCELL_CONTROLLER_CONTAINER", "controller")
for command in ("docker", "kubectl", "make", "skopeo"):
    if not shutil.which(command):
        raise SystemExit(f"required command not found: {command}")
dockerfile = source / "deploy/controller.Dockerfile"
crd = source / "deploy/crd.yaml"
if not dockerfile.is_file() or not crd.is_file():
    raise SystemExit(f"Cellbox controller source is missing at {source}")
with urllib.request.urlopen(endpoint + "/v2/", timeout=8) as response:
    if response.status != 200:
        raise SystemExit(f"Registry unavailable at {endpoint}")
current = json.loads(run(*kube("get", "daemonset", daemonset, "-o", "json"), capture=True))
if sum(c["name"] == container for c in current["spec"]["template"]["spec"]["containers"]) != 1:
    raise SystemExit(f"Expected container {container} in daemonset {daemonset}")

if os.environ.get("CELLBOX_SKIP_BUILD") != "1":
    run("make", "-C", str(source), "build")
tag = os.environ.get("COCELL_CELLBOX_CONTROLLER_IMAGE_TAG", time.strftime("controller-%Y%m%d-%H%M%S", time.gmtime()))
image = f"{repository}:{tag}"
run("docker", "build", "--platform", "linux/amd64", "-f", str(dockerfile), "-t", image, str(source / "dist/release"))
with tempfile.TemporaryDirectory(prefix="cellbox-controller-deploy-") as temporary:
    archive = str(Path(temporary) / "image.tar")
    run("docker", "save", "--output", archive, image)
    run("skopeo", "copy", "--dest-tls-verify=false", f"docker-archive:{archive}", f"docker://{image}")
published = json.loads(run("skopeo", "inspect", "--tls-verify=false", f"docker://{image}", capture=True))
digest = published["Digest"]
if not digest.startswith("sha256:") or len(digest) != 71:
    raise SystemExit("Registry did not return a valid image digest")
immutable_image = f"{repository}@{digest}"

print("Applying ResumablePod CRD", flush=True)
run("kubectl", "--context", context, "apply", "-f", str(crd))
run("kubectl", "--context", context, "wait", "--for=condition=Established", "crd/resumablepods.recovery.gvisor.dev", "--timeout=90s")
print(f"Rolling out {daemonset}/{container}: {immutable_image}", flush=True)
run(*kube("set", "image", f"daemonset/{daemonset}", f"{container}={immutable_image}"))
updated = json.loads(run(*kube("get", "daemonset", daemonset, "-o", "json"), capture=True))
selector = updated["spec"]["selector"]["matchLabels"]
label_selector = ",".join(f"{key}={value}" for key, value in selector.items())
if updated["spec"].get("updateStrategy", {}).get("type") == "OnDelete":
    pods = json.loads(run(*kube("get", "pods", "-l", label_selector, "-o", "json"), capture=True))["items"]
    for pod in pods:
        if not any(digest in status.get("imageID", "") for status in pod["status"].get("containerStatuses", []) if status["name"] == container):
            run(*kube("delete", "pod", pod["metadata"]["name"], "--wait=false"))
else:
    run(*kube("rollout", "status", f"daemonset/{daemonset}", "--timeout=5m"))

deadline = time.monotonic() + 300
while time.monotonic() < deadline:
    updated = json.loads(run(*kube("get", "daemonset", daemonset, "-o", "json"), capture=True))
    pods = json.loads(run(*kube("get", "pods", "-l", label_selector, "-o", "json"), capture=True))["items"]
    ready = [pod for pod in pods if pod["status"].get("phase") == "Running"
             and any(status["name"] == container and status.get("ready") and digest in status.get("imageID", "")
                     for status in pod["status"].get("containerStatuses", []))]
    if updated["status"].get("desiredNumberScheduled", 0) > 0 and len(ready) == updated["status"]["desiredNumberScheduled"]:
        break
    time.sleep(3)
else:
    raise RuntimeError("Controller Pods did not become ready with the published image digest")
print(f"Deployed {immutable_image}", flush=True)
