"""Shared build and Helm rollout helpers for the external Cellbox release."""

import base64
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


class CellboxRelease:
    def __init__(self, source: str):
        self.source = Path(source).expanduser().resolve()
        self.chart = self.source / "charts/cellbox"
        if not (self.chart / "Chart.yaml").is_file():
            raise RuntimeError(f"Cellbox Helm chart not found at {self.chart}")
        self.context = os.environ.get("COCELL_KUBE_CONTEXT", "k3s")
        self.namespace = os.environ.get("COCELL_CELLBOX_NAMESPACE", "cell-box")
        self.release = os.environ.get("COCELL_CELLBOX_RELEASE", "cellbox")
        for command in ("make", "docker", "skopeo", "kubectl", "helm"):
            if not shutil.which(command):
                raise RuntimeError(f"required command not found: {command}")
        self.values = json.loads(run("helm", "get", "values", self.release, "--kube-context", self.context,
                                    "--namespace", self.namespace, "--all", "--output", "json", capture=True))
        self.api_namespace = self.values["api"].get("namespace") or self.namespace

    def kube(self, *args: str, namespace: str | None = None) -> tuple[str, ...]:
        return ("kubectl", "--context", self.context, "--namespace", namespace or self.namespace, *args)

    def publish(self, component: str) -> str:
        endpoint = os.environ.get("COCELL_REGISTRY_ENDPOINT", "")
        if not re.fullmatch(r"http://[^/\s]+", endpoint):
            raise RuntimeError("Set COCELL_REGISTRY_ENDPOINT to an HTTP registry origin")
        host = endpoint[7:]
        prefix = f"COCELL_CELLBOX_{component.upper()}_IMAGE"
        repository = os.environ.get(f"{prefix}_REPOSITORY", f"{host}/cellbox-{component}")
        if not repository.startswith(host + "/"):
            raise RuntimeError(f"Cellbox image repository must be on {host}")
        dockerfile = self.source / f"images/{'cellbox-api' if component == 'api' else 'controller'}.Dockerfile"
        if not dockerfile.is_file():
            raise RuntimeError(f"Cellbox Dockerfile not found at {dockerfile}")
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(endpoint + "/v2/", timeout=8) as response:
            if response.status != 200:
                raise RuntimeError(f"Registry unavailable at {endpoint}")
        if os.environ.get("CELLBOX_SKIP_BUILD") != "1":
            run("make", "-C", str(self.source), "build")
        tag = os.environ.get(f"{prefix}_TAG", time.strftime(f"{component}-%Y%m%d-%H%M%S", time.gmtime()))
        image = f"{repository}:{tag}"
        run("docker", "build", "--platform", "linux/amd64", "-f", str(dockerfile), "-t", image, str(self.source / "dist/release"))
        with tempfile.TemporaryDirectory(prefix="cellbox-deploy-") as temporary:
            archive = str(Path(temporary) / "image.tar")
            run("docker", "save", "--output", archive, image)
            run("skopeo", "copy", "--dest-tls-verify=false", f"docker-archive:{archive}", f"docker://{image}")
        digest = json.loads(run("skopeo", "inspect", "--tls-verify=false", f"docker://{image}", capture=True))["Digest"]
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise RuntimeError("Registry did not return a valid image digest")
        immutable_image = f"{repository}@{digest}"
        print(f"Published {immutable_image}", flush=True)
        return immutable_image

    def check_lifecycle_operations(self) -> None:
        api = self.values["api"]
        secret = json.loads(run(*self.kube("get", "secret", api["configSecret"], "-o", "json", namespace=self.api_namespace), capture=True))
        config = json.loads(base64.b64decode(secret["data"]["config.json"]))
        tokens = json.loads(run(*self.kube("get", "secret", api["clientTokensSecret"], "-o", "json", namespace=self.api_namespace), capture=True))["data"]
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        forward = subprocess.Popen(self.kube("port-forward", "service/cellbox-api", f"{port}:8090", "--address", "127.0.0.1", namespace=self.api_namespace),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            for attempt in range(50):
                if forward.poll() is not None:
                    raise RuntimeError("Cellbox port-forward exited before the operation check")
                try:
                    with opener.open(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
                        if response.status == 200:
                            break
                except urllib.error.URLError:
                    if attempt == 49:
                        raise RuntimeError("Cellbox API did not respond to the operation check")
                    time.sleep(0.1)
            count = 0
            for client in config["clients"]:
                token = base64.b64decode(tokens[client["tokenEnv"]]).decode()
                request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/boxes", headers={"Authorization": f"Bearer {token}"})
                with opener.open(request, timeout=30) as response:
                    boxes = json.load(response)
                if not isinstance(boxes, list):
                    raise RuntimeError("Unexpected response from Cellbox box list")
                if any(box.get("operationId") for box in boxes):
                    raise RuntimeError("Cellbox has pending box operations; rollout stopped")
                count += len(boxes)
            print(f"No pending box operations across {count} boxes", flush=True)
        finally:
            forward.terminate()
            try:
                forward.wait(timeout=5)
            except subprocess.TimeoutExpired:
                forward.kill()
                forward.wait()
            forward.stderr.close()

    def upgrade(self, overrides: dict) -> None:
        with tempfile.TemporaryDirectory(prefix="cellbox-helm-") as temporary:
            values = Path(temporary) / "overrides.json"
            values.write_text(json.dumps(overrides))
            values.chmod(0o600)
            run("helm", "upgrade", self.release, str(self.chart), "--kube-context", self.context,
                "--namespace", self.namespace, "--reuse-values", "--values", str(values), "--wait", "--timeout", "10m")

    def verify(self, kind: str, name: str, image: str, namespace: str, containers: tuple[str, ...]) -> None:
        workload = json.loads(run(*self.kube("get", kind, name, "-o", "json", namespace=namespace), capture=True))
        spec = workload["spec"]["template"]["spec"]
        expected = [c for c in spec.get("containers", []) + spec.get("initContainers", []) if c["name"] in containers]
        if not expected or any(c["image"] != image for c in expected):
            raise RuntimeError("Cellbox workload image changed during rollout")
        selector = ",".join(f"{k}={v}" for k, v in workload["spec"]["selector"]["matchLabels"].items())
        pods = json.loads(run(*self.kube("get", "pods", "-l", selector, "-o", "json", namespace=namespace), capture=True))["items"]
        ready = [pod for pod in pods if not pod["metadata"].get("deletionTimestamp") and pod["status"].get("phase") == "Running"
                 and all(any(status["name"] == c["name"] and image.split("@", 1)[1] in status.get("imageID", "")
                             and (status.get("ready") if c in spec.get("containers", []) else status.get("state", {}).get("terminated", {}).get("exitCode") == 0)
                             for status in pod["status"].get("containerStatuses", []) + pod["status"].get("initContainerStatuses", [])) for c in expected)]
        count = workload["status"].get("desiredNumberScheduled", 0) if kind == "daemonset" else workload["spec"].get("replicas", 1)
        if count < 1 or len(ready) != count:
            raise RuntimeError("Cellbox Pods do not report the published image digest")
        print(f"Deployed {image}", flush=True)
