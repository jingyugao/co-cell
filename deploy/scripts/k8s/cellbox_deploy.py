"""Build and deploy the single-process Cellbox server release."""

import json
from copy import deepcopy
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request


def run(*args: str, capture: bool = False, check: bool = True) -> str:
    result = subprocess.run(args, check=check, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


class CellboxRelease:
    def __init__(self, source: str):
        self.source = Path(source).expanduser().resolve()
        self.chart = self.source / "charts/cellbox"
        self.dockerfile = self.source / "images/cellbox-server.Dockerfile"
        if not (self.chart / "Chart.yaml").is_file() or not self.dockerfile.is_file():
            raise RuntimeError("Cellbox source must contain the single-server Helm chart and Dockerfile")
        self.context = os.environ.get("COCELL_KUBE_CONTEXT", "k3s")
        self.namespace = os.environ.get("COCELL_CELLBOX_NAMESPACE", "cell-box")
        self.release = os.environ.get("COCELL_CELLBOX_RELEASE", "cellbox")
        self.node_name = os.environ.get("COCELL_CELLBOX_NODE_NAME", "").strip()
        self.profile_id = os.environ.get("CELLBOX_PROFILE", "").strip()
        self.storage_host_path = os.environ.get("COCELL_CELLBOX_STORAGE_HOST_PATH", "").strip()
        self.storage_claim = os.environ.get("COCELL_CELLBOX_STORAGE_CLAIM", "").strip()
        self.object_prefix = os.environ.get("COCELL_CELLBOX_OBJECT_STORAGE_PREFIX", "").strip()
        if not self.node_name:
            raise RuntimeError("Set COCELL_CELLBOX_NODE_NAME to the dedicated Cellbox runtime node")
        if not self.profile_id:
            raise RuntimeError("Set CELLBOX_PROFILE to the configured Cellbox runtime profile")
        if self.storage_host_path and self.storage_claim:
            raise RuntimeError("Configure at most one of COCELL_CELLBOX_STORAGE_HOST_PATH or COCELL_CELLBOX_STORAGE_CLAIM")
        for command in ("make", "docker", "kubectl", "helm"):
            if not shutil.which(command):
                raise RuntimeError(f"required command not found: {command}")

    def kube(self, *args: str) -> tuple[str, ...]:
        return ("kubectl", "--context", self.context, "--namespace", self.namespace, *args)

    def publish_server(self) -> str:
        endpoint = os.environ.get("COCELL_REGISTRY_ENDPOINT", "")
        if not re.fullmatch(r"http://[^/\s]+", endpoint):
            raise RuntimeError("Set COCELL_REGISTRY_ENDPOINT to an HTTP registry origin")
        host = endpoint[7:]
        repository = os.environ.get("COCELL_CELLBOX_SERVER_IMAGE_REPOSITORY", f"{host}/cellbox-server")
        if not repository.startswith(host + "/"):
            raise RuntimeError(f"Cellbox server image repository must be on {host}")
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(endpoint + "/v2/", timeout=8) as response:
            if response.status != 200:
                raise RuntimeError("Cellbox image registry is unavailable")
        if os.environ.get("CELLBOX_SKIP_BUILD") != "1":
            run("make", "-C", str(self.source), "build")
        release_dir = self.source / "dist/release"
        if not (release_dir / "cellbox-server").is_file():
            raise RuntimeError("Cellbox release output is missing cellbox-server; run make build")
        tag = os.environ.get("COCELL_CELLBOX_SERVER_IMAGE_TAG", time.strftime("server-%Y%m%d-%H%M%S", time.gmtime()))
        image = f"{repository}:{tag}"
        run("docker", "build", "--platform", "linux/amd64", "-f", str(self.dockerfile), "-t", image, str(release_dir))
        run("docker", "push", image)
        request = urllib.request.Request(
            f"{endpoint}/v2/{repository[len(host) + 1:]}/manifests/{tag}", method="HEAD",
            headers={"Accept": "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30) as response:
            digest = response.headers.get("Docker-Content-Digest", "")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise RuntimeError("Registry did not return a valid Cellbox server image digest")
        image = f"{repository}@{digest}"
        print(f"Published {image}", flush=True)
        return image

    def values(self) -> tuple[dict, dict | None]:
        # Preserve only installation-owned configuration needed by the new chart.
        result = subprocess.run(("helm", "get", "values", self.release, "--kube-context", self.context,
                                 "--namespace", self.namespace, "--all", "--output", "json"),
                                check=False, text=True, stdout=subprocess.PIPE)
        existing = json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else None
        if existing is None:
            raise RuntimeError("Cellbox Helm release must already exist; install and review the single-server chart separately")
        existing_server = existing.get("server", {})
        legacy_migration = not (isinstance(existing_server, dict) and existing_server.get("nodeName"))
        values = {}
        if isinstance(existing.get("imageRegistry"), str) and existing["imageRegistry"].strip():
            values["imageRegistry"] = existing["imageRegistry"]
        for key in ("objectStorage", "buildkit"):
            if isinstance(existing.get(key), dict):
                values[key] = deepcopy(existing[key])
        old_api = existing.get("api", {})
        api = {key: old_api[key] for key in ("namespace", "extraEnv", "nodeSelector", "configSecret", "manageSecrets", "initImage")
               if key in old_api}
        config = dict(old_api.get("config", {}))
        config.pop("publicUrl", None)  # Removed with Cellbox's route/domain management.
        # A separately managed config Secret is intentionally opaque to Helm values.
        # The template bootstrap validates the selected profile through Cellbox's API.
        if api.get("manageSecrets", True):
            profiles = config.get("profiles", [])
            if not isinstance(profiles, list) or not any(profile.get("id") == self.profile_id for profile in profiles):
                raise RuntimeError(f"CELLBOX_PROFILE {self.profile_id!r} is not present in the existing Cellbox profile configuration")
            for profile in profiles:
                if profile.get("id") == self.profile_id and profile.get("nodeName") not in (None, "", self.node_name):
                    raise RuntimeError("CELLBOX_PROFILE nodeName must match COCELL_CELLBOX_NODE_NAME")
        config["dataDir"] = "/var/lib/cellbox-data"
        api.update({"enabled": True, "namespace": self.namespace, "replicas": 1, "config": config})
        values["api"] = api
        controller = existing.get("controller", {})
        allowed_controller = ("warmPoolSize", "extraEnv", "criDirectory", "criSocket", "nodeSelector", "tolerations")
        values["controller"] = {key: controller[key] for key in allowed_controller if key in controller}
        server = existing.get("server", {})
        values["server"] = {key: server[key] for key in ("resources",) if key in server}
        values["server"].update({"nodeName": self.node_name})
        old_storage = existing.get("storage", {})
        if not isinstance(old_storage, dict):
            raise RuntimeError("Existing Cellbox storage values are invalid")
        old_host = str(old_storage.get("hostPath", "")).strip()
        old_claim = str(old_storage.get("existingClaim", "")).strip()
        if legacy_migration:
            if bool(self.storage_host_path) == bool(self.storage_claim):
                raise RuntimeError("For legacy migration, set exactly one new Cellbox storage hostPath or claim")
            if self.storage_host_path:
                if not self.storage_host_path.startswith("/") or self.storage_host_path in ("", "/") or self.storage_host_path.endswith("/"):
                    raise RuntimeError("COCELL_CELLBOX_STORAGE_HOST_PATH must be a clean absolute directory other than /")
                if old_host and old_host == self.storage_host_path:
                    raise RuntimeError("Legacy Cellbox migration requires a new hostPath")
                storage = {**old_storage, "hostPath": self.storage_host_path, "existingClaim": ""}
            else:
                if old_claim and old_claim == self.storage_claim:
                    raise RuntimeError("Legacy Cellbox migration requires a new PVC claim")
                storage = {**old_storage, "hostPath": "", "existingClaim": self.storage_claim}
        else:
            if bool(old_host) == bool(old_claim):
                raise RuntimeError("Existing single-server release must have exactly one configured storage path")
            if self.storage_host_path and self.storage_host_path != old_host:
                raise RuntimeError("Refusing to change storage for an existing single-server release")
            if self.storage_claim and self.storage_claim != old_claim:
                raise RuntimeError("Refusing to change storage for an existing single-server release")
            storage = old_storage
        values["storage"] = storage
        object_storage = values.get("objectStorage", {})
        if object_storage.get("endpoint") or object_storage.get("bucket"):
            old_prefix = object_storage.get("prefix", "").strip("/")
            if legacy_migration:
                if not self.object_prefix or self.object_prefix.strip("/") == old_prefix:
                    raise RuntimeError("Legacy Cellbox migration requires a new COCELL_CELLBOX_OBJECT_STORAGE_PREFIX")
                object_storage["prefix"] = self.object_prefix.strip("/")
            elif self.object_prefix:
                if self.object_prefix.strip("/") != old_prefix:
                    raise RuntimeError("Refusing to change object storage prefix for an existing single-server release")
            values["objectStorage"] = object_storage
        return values, existing

    def check_lifecycle_operations(self, values: dict) -> None:
        client = os.environ.get("CELLBOX_CLIENT_ID", "").strip()
        if not client:
            client = values.get("api", {}).get("config", {}).get("clientId", "internal")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        forward = subprocess.Popen(self.kube("port-forward", "service/cellbox-api", f"{port}:8090", "--address", "127.0.0.1"),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            endpoint = f"http://127.0.0.1:{port}/v1/boxes"
            for attempt in range(50):
                if forward.poll() is not None:
                    raise RuntimeError("Cellbox port-forward exited before the read-only operation check")
                try:
                    request = urllib.request.Request(endpoint, headers={"X-Cellbox-Client-ID": client})
                    with urllib.request.urlopen(request, timeout=3) as response:
                        if response.status != 200:
                            raise RuntimeError("Cellbox read-only operation check failed")
                        boxes = json.load(response)
                    if not isinstance(boxes, list):
                        raise RuntimeError("Cellbox returned an invalid Box inventory")
                    active = sum(bool(box.get("operationId")) for box in boxes)
                    if active:
                        raise RuntimeError(f"Cellbox has {active} active Box operation(s); rollout stopped")
                    print(f"No active Box operations across {len(boxes)} runtime resources", flush=True)
                    return
                except OSError:
                    if attempt == 49:
                        raise RuntimeError("Cellbox did not respond to the read-only operation check")
                    time.sleep(0.1)
        finally:
            forward.terminate()
            try:
                forward.wait(timeout=5)
            except subprocess.TimeoutExpired:
                forward.kill()
                forward.wait()

    def deploy(self, image: str) -> None:
        values, _ = self.values()
        self.check_lifecycle_operations(values)
        values["server"]["image"] = image
        values["server"]["imagePullPolicy"] = "IfNotPresent"
        with tempfile.TemporaryDirectory(prefix="cellbox-server-helm-") as temporary:
            values_file = Path(temporary) / "values.json"
            values_file.write_text(json.dumps(values))
            values_file.chmod(0o600)
            run("helm", "template", self.release, str(self.chart), "--kube-context", self.context,
                "--namespace", self.namespace, "--values", str(values_file), capture=True)
            run("helm", "upgrade", self.release, str(self.chart), "--kube-context", self.context,
                "--namespace", self.namespace, "--reset-values", "--values", str(values_file), "--wait", "--timeout", "10m")
        workload = json.loads(run(*self.kube("get", "deployment", "cellbox-server", "-o", "json"), capture=True))
        containers = workload["spec"]["template"]["spec"].get("containers", [])
        if workload["spec"].get("replicas") != 1 or not any(c.get("name") == "server" and c.get("image") == image for c in containers):
            raise RuntimeError("Cellbox server deployment does not match the single-replica image configuration")
        run(*self.kube("rollout", "status", "deployment/cellbox-server", "--timeout=180s"))
        pods = json.loads(run(*self.kube("get", "pods", "-l", "app=cellbox-server", "-o", "json"), capture=True)).get("items", [])
        digest = image.split("@", 1)[1]
        ready = [pod for pod in pods if not pod["metadata"].get("deletionTimestamp") and pod.get("status", {}).get("phase") == "Running"
                 and any(status.get("name") == "server" and status.get("ready") and digest in status.get("imageID", "")
                         for status in pod.get("status", {}).get("containerStatuses", []))]
        if len(ready) != 1:
            raise RuntimeError("Cellbox server Pod does not report the published image digest")
        print(f"Verified single-replica Cellbox server {image}", flush=True)
