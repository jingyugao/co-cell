#!/usr/bin/env python3
"""Build, publish, and roll out the Cellbox API from its source tree."""

import base64
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


def kargs(*args: str) -> tuple[str, ...]:
    return ("kubectl", "--context", context, "--namespace", namespace, *args)


def json_command(*args: str):
    return json.loads(run(*args, capture=True))


def check_active_operations() -> None:
    secret = json_command(*kargs("get", "secret", token_secret, "-o", "json"))
    token = base64.b64decode(secret["data"]["CELLBOX_API_TOKEN"]).decode()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    forward = subprocess.Popen(
        kargs("port-forward", f"service/{deployment}", f"{port}:8090", "--address", "127.0.0.1"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        url = f"http://127.0.0.1:{port}/v1/boxes"
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        for attempt in range(50):
            if forward.poll() is not None:
                raise RuntimeError(f"Cellbox port-forward exited: {forward.stderr.read().strip()}")
            try:
                with urllib.request.urlopen(request, timeout=2) as response:
                    boxes = json.load(response)
                break
            except urllib.error.URLError:
                if attempt == 49:
                    raise RuntimeError("Cellbox API did not respond to the active operation check")
                time.sleep(0.1)
        if not isinstance(boxes, list):
            raise RuntimeError("Unexpected response from Cellbox box list")
        active = [box["id"] for box in boxes if box.get("operationId") or box.get("activeOperations")]
        if active:
            raise RuntimeError(f"Cellbox has active operations on {len(active)} box(es); rollout stopped")
        print(f"No active Cellbox operations across {len(boxes)} boxes", flush=True)
    finally:
        forward.terminate()
        try:
            forward.wait(timeout=5)
        except subprocess.TimeoutExpired:
            forward.kill()
            forward.wait()
        forward.stderr.close()


def require_setting(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"Set {name} before deploying")
    return value


if len(sys.argv) != 2:
    raise SystemExit("usage: deploy-cellbox-api.py CELLBOX_SOURCE_DIR")

source = Path(sys.argv[1]).expanduser().resolve()
endpoint = require_setting("COCELL_REGISTRY_ENDPOINT")
if not endpoint.startswith("http://") or "/" in endpoint[7:]:
    raise SystemExit("COCELL_REGISTRY_ENDPOINT must be an HTTP registry origin")
host = endpoint[7:]
repository = os.environ.get("COCELL_CELLBOX_API_IMAGE_REPOSITORY", f"{host}/cellbox-api")
if not repository.startswith(host + "/"):
    raise SystemExit(f"Cellbox API image repository must be on {host}")
context = os.environ.get("COCELL_KUBE_CONTEXT", "k3s")
namespace = os.environ.get("COCELL_NAMESPACE", "co-cell")
deployment = os.environ.get("COCELL_CELLBOX_API_DEPLOYMENT", "cellbox-api")
container = os.environ.get("COCELL_CELLBOX_API_CONTAINER", "api")
token_secret = os.environ.get("COCELL_SECRET", "co-cell-secrets")

if not (source / "Makefile").is_file() or not (source / "deploy/cellbox-api.Dockerfile").is_file():
    raise SystemExit(f"Cellbox source tree not found at {source}")
for command in ("make", "docker", "skopeo", "kubectl"):
    if not shutil.which(command):
        raise SystemExit(f"required command not found: {command}")
with urllib.request.urlopen(endpoint + "/v2/", timeout=8) as response:
    if response.status != 200:
        raise SystemExit(f"Registry unavailable at {endpoint}")

deployment_data = json_command(*kargs("get", "deployment", deployment, "-o", "json"))
containers = [c for c in deployment_data["spec"]["template"]["spec"]["containers"] if c["name"] == container]
if len(containers) != 1:
    raise SystemExit(f"Expected container {container} in deployment {deployment}")
if deployment_data["spec"].get("strategy", {}).get("type") != "Recreate":
    raise SystemExit(f"Expected Recreate strategy for deployment {deployment}")

if os.environ.get("CELLBOX_SKIP_BUILD") != "1":
    print(f"Building Cellbox in {source}", flush=True)
    run("make", "-C", str(source), "build")
tag = os.environ.get("COCELL_CELLBOX_API_IMAGE_TAG", time.strftime("api-%Y%m%d-%H%M%S", time.gmtime()))
image = f"{repository}:{tag}"
run("docker", "build", "--platform", "linux/amd64", "-f", str(source / "deploy/cellbox-api.Dockerfile"), "-t", image, str(source / "dist/release"))

with tempfile.TemporaryDirectory(prefix="cellbox-api-deploy-") as temporary:
    archive = str(Path(temporary) / "image.tar")
    run("docker", "save", "--output", archive, image)
    run("skopeo", "copy", "--dest-tls-verify=false", f"docker-archive:{archive}", f"docker://{image}")
published = json_command("skopeo", "inspect", "--tls-verify=false", f"docker://{image}")
digest = published["Digest"]
if not digest.startswith("sha256:") or len(digest) != 71:
    raise SystemExit("Registry did not return a valid image digest")
immutable_image = f"{repository}@{digest}"
print(f"Published {immutable_image}", flush=True)

current_image = containers[0]["image"]
if current_image == immutable_image:
    print("Cellbox API already uses this digest", flush=True)
    raise SystemExit(0)
check_active_operations()
print(f"Rolling out {deployment}/{container}", flush=True)
run(*kargs("set", "image", f"deployment/{deployment}", f"{container}={immutable_image}"))
run(*kargs("rollout", "status", f"deployment/{deployment}", "--timeout=5m"))
updated = json_command(*kargs("get", "deployment", deployment, "-o", "json"))
new_containers = updated["spec"]["template"]["spec"]["containers"]
if next(c["image"] for c in new_containers if c["name"] == container) != immutable_image:
    raise RuntimeError("Cellbox API deployment image changed during rollout")
selector = updated["spec"]["selector"]["matchLabels"]
pods = json_command(*kargs("get", "pods", "-l", ",".join(f"{k}={v}" for k, v in selector.items()), "-o", "json"))["items"]
ready = [status for pod in pods if pod["status"].get("phase") == "Running"
         for status in pod["status"].get("containerStatuses", [])
         if status["name"] == container and status.get("ready") and digest in status.get("imageID", "")]
if not ready:
    raise RuntimeError("No ready Cellbox API Pod reports the published image digest")
print(f"Deployed {immutable_image}", flush=True)
