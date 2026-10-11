#!/usr/bin/env python3
"""Import Cellbox metadata to one persistent node, then disable bootstrap."""

import base64
from contextlib import contextmanager
import json
import os
from pathlib import PurePosixPath
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

from cellbox_deploy import CellboxRelease, run


@contextmanager
def api_reader(release):
    secret = json.loads(run(*release.kube("get", "secret", release.values["api"]["configSecret"], "-o", "json",
                                         namespace=release.api_namespace), capture=True))
    config = json.loads(base64.b64decode(secret["data"]["config.json"]))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    process = subprocess.Popen(release.kube("port-forward", "service/cellbox-api", f"{port}:8090", "--address", "127.0.0.1",
                                            namespace=release.api_namespace), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def read(path):
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"X-Cellbox-Client-ID": config.get("clientId") or "internal"})
        with opener.open(request, timeout=30) as response:
            return json.load(response)

    try:
        for attempt in range(100):
            if process.poll() is not None:
                raise RuntimeError("Cellbox API port-forward exited")
            try:
                read("/v1/profiles")
                break
            except urllib.error.URLError:
                if attempt == 99:
                    raise RuntimeError("Cellbox API did not become reachable")
                time.sleep(0.1)
        yield read, config
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def inventory(read):
    result = {}
    for kind in ("boxes", "images", "archives", "checkpoints"):
        records = read(f"/v1/{kind}")
        if not isinstance(records, list) or any(not row.get("id") for row in records):
            raise RuntimeError(f"Unexpected Cellbox {kind} inventory")
        if kind == "boxes" and any(row.get("operationId") for row in records):
            raise RuntimeError("Cellbox has pending lifecycle operations; migration stopped")
        result[kind] = sorted(row["id"] for row in records)
    return result


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: deploy-cellbox-local-metadata.py CELLBOX_SOURCE_DIR")
    release = CellboxRelease(sys.argv[1])
    if release.values.get("localMetadata", {}).get("enabled"):
        raise RuntimeError("Local metadata is already enabled; use normal API/controller deployment targets")
    if not release.values["controller"]["enabled"] or release.values["api"]["replicas"] != 1:
        raise RuntimeError("Local metadata requires one API and one controller node")
    pods = json.loads(run(*release.kube("get", "pods", "-l", "app=cellbox-api", "-o", "json", namespace=release.api_namespace), capture=True))["items"]
    pods = [pod for pod in pods if not pod["metadata"].get("deletionTimestamp") and pod["status"].get("phase") == "Running"]
    if len(pods) != 1:
        raise RuntimeError("Expected exactly one running Cellbox API Pod")
    node = pods[0]["spec"]["nodeName"]
    controller = release.values["controller"]["name"]
    controller_pods = json.loads(run(*release.kube("get", "pods", "-l", f"app={controller}", "-o", "json"), capture=True))["items"]
    if len(controller_pods) != 1 or controller_pods[0]["spec"]["nodeName"] != node:
        raise RuntimeError("Local metadata currently requires API and controller on the same single node")
    host_path = os.environ.get("COCELL_CELLBOX_METADATA_HOST_PATH", "/var/lib/cellbox-metadata")
    if not host_path.startswith("/") or str(PurePosixPath(host_path)) != host_path or host_path == "/" or ".." in PurePosixPath(host_path).parts:
        raise RuntimeError("COCELL_CELLBOX_METADATA_HOST_PATH must be a clean dedicated absolute path")
    # Require a fresh dedicated destination. An existing initialized directory
    # could belong to an older installation and must never silently win over S3.
    run(*release.kube("exec", controller_pods[0]["metadata"]["name"], "--", "/bin/sh", "-ec",
                      'test ! -e "$1" && test ! -L "$1"', "metadata-destination-check", "/proc/1/root" + host_path))
    with api_reader(release) as (read, config):
        inventory(read)
        if config.get("localMetadataDir"):
            raise RuntimeError("Cellbox config already selects local metadata")
        if any(profile.get("provider") == "resumable-k8s-pod" and profile.get("nodeName") != node for profile in config.get("profiles", [])):
            raise RuntimeError("All resumable profiles must use the metadata node")
    api_image = release.publish("api")
    os.environ["CELLBOX_SKIP_BUILD"] = "1"
    controller_image = release.publish("controller")
    release.check_lifecycle_operations()
    with api_reader(release) as (read, _):
        before = inventory(read)
    # Stop every old writer before importing. Neither a rolling migration nor
    # automatic rollback to the now-stale remote metadata is safe.
    run(*release.kube("scale", "deployment/cellbox-api", "--replicas=0", namespace=release.api_namespace))
    run(*release.kube("wait", "--for=delete", "pod", "-l", "app=cellbox-api", "--timeout=120s", namespace=release.api_namespace))
    run(*release.kube("delete", f"daemonset/{controller}", "--cascade=foreground", "--wait=true", "--timeout=120s"))
    options = {"enabled": True, "initialize": True, "nodeName": node, "hostPath": host_path}
    release.upgrade({"api": {"image": api_image}, "controller": {"image": controller_image}, "localMetadata": options})
    release.verify("deployment", "cellbox-api", api_image, release.api_namespace, ("api",))
    release.verify("daemonset", controller, controller_image, release.namespace, ("controller",))
    with api_reader(release) as (read, _):
        after = inventory(read)
    if after != before:
        raise RuntimeError("Resource identities changed during metadata migration; local store retained for inspection")
    # Normal starts must require existing local state, never reimport old S3
    # records if a node directory is missing. This also verifies a Pod restart.
    options["initialize"] = False
    release.upgrade({"localMetadata": options})
    release.verify("deployment", "cellbox-api", api_image, release.api_namespace, ("api",))
    with api_reader(release) as (read, _):
        if inventory(read) != before:
            raise RuntimeError("Resource identities changed after reopening local metadata")
    print(f"Local metadata enabled on node {node}; bootstrap disabled; preserved counts: " +
          json.dumps({key: len(value) for key, value in before.items()}), flush=True)


if __name__ == "__main__":
    main()
