#!/usr/bin/env python3
"""Submit one explicit system template/revision build and print its selectors."""

import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def request(base: str, path: str, client: str, method: str = "GET", payload: dict | None = None) -> tuple[int, dict | list | None]:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"X-Cellbox-Client-ID": client, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        return error.code, None


def write_selector(path: str, template_id: str, revision_id: str) -> None:
    """Atomically write confirmed selectors without exposing them to other users."""
    destination = Path(path).expanduser()
    parent = destination.parent
    if not parent.is_dir():
        raise RuntimeError("COCELL_CELLBOX_SELECTOR_OUTPUT parent directory must exist")
    descriptor, temporary = tempfile.mkstemp(prefix=".cellbox-selector-", dir=parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump({"templateId": template_id, "revisionId": revision_id}, output)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: bootstrap-template.py IMMUTABLE_SANDBOX_IMAGE")
    image = sys.argv[1]
    if not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", image):
        raise SystemExit("Expected an immutable repository@sha256:digest image")
    profile = os.environ.get("CELLBOX_PROFILE", "").strip()
    client = os.environ.get("CELLBOX_CLIENT_ID", "").strip()
    family_id = os.environ.get("CELLBOX_TEMPLATE_ID", "").strip()
    selected_revision = os.environ.get("CELLBOX_REVISION_ID", "").strip()
    create = os.environ.get("COCELL_CELLBOX_CREATE_TEMPLATE") == "1"
    if not profile or not client:
        raise SystemExit("Set CELLBOX_PROFILE and CELLBOX_CLIENT_ID before template bootstrap")
    if family_id and selected_revision:
        raise SystemExit("Set at most one of CELLBOX_TEMPLATE_ID and CELLBOX_REVISION_ID")
    if not family_id and not selected_revision and not create:
        raise SystemExit("Set CELLBOX_TEMPLATE_ID or explicitly set COCELL_CELLBOX_CREATE_TEMPLATE=1")
    if (family_id or selected_revision) and create:
        raise SystemExit("Use an existing template/revision selector or COCELL_CELLBOX_CREATE_TEMPLATE, not both")
    context = os.environ.get("COCELL_KUBE_CONTEXT", "k3s")
    namespace = os.environ.get("COCELL_CELLBOX_NAMESPACE", "cell-box")
    local_port = int(os.environ.get("COCELL_CELLBOX_LOCAL_PORT", "0"))
    if local_port == 0:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            local_port = sock.getsockname()[1]
    process = subprocess.Popen(("kubectl", "--context", context, "--namespace", namespace, "port-forward",
                                "service/cellbox-api", f"{local_port}:8090", "--address", "127.0.0.1"),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{local_port}"
    try:
        for _ in range(50):
            if process.poll() is not None:
                raise RuntimeError("Cellbox port-forward failed")
            try:
                with urllib.request.urlopen(base + "/healthz", timeout=2) as response:
                    if response.status == 200:
                        break
            except urllib.error.URLError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Cellbox did not respond through the local port-forward")

        status, profiles = request(base, "/v1/profiles", client)
        if status != 200 or not isinstance(profiles, list) or not any(p.get("id") == profile for p in profiles):
            raise RuntimeError("Configured CELLBOX_PROFILE is not available in Cellbox")

        if create:
            # This POST is deliberately submitted once. An interrupted response is an unknown outcome;
            # the operator must inspect the catalog before attempting another create.
            status, template = request(base, "/v1/templates", client, "POST",
                                       {"name": os.environ.get("COCELL_CELLBOX_TEMPLATE_NAME", "cocell-system"),
                                        "description": "CoCell system runtime", "defaultWarmSlots": 0})
            if status != 201 or not isinstance(template, dict) or not template.get("id"):
                raise RuntimeError("Template create did not return a confirmed ID; inspect the catalog before retrying")
            family_id = template["id"]
            print(f"Created template family {family_id}")
        elif selected_revision:
            status, revision = request(base, "/v1/template-revisions/" + selected_revision, client)
            if status != 200 or not isinstance(revision, dict) or not revision.get("templateId"):
                raise RuntimeError("Configured CELLBOX_REVISION_ID was not found for this client")
            family_id = revision["templateId"]
        else:
            status, template = request(base, "/v1/templates/" + family_id, client)
            if status != 200 or not isinstance(template, dict):
                raise RuntimeError("Configured CELLBOX_TEMPLATE_ID was not found for this client")

        version = os.environ.get("COCELL_SANDBOX_IMAGE_TAG", "").removeprefix("v")
        if not version:
            raise RuntimeError("Set COCELL_SANDBOX_IMAGE_TAG to identify the built runtime revision")
        # This POST also has no retry key. Any uncertain result must be resolved by reading the catalog.
        status, operation = request(base, f"/v1/templates/{family_id}/revisions", client, "POST",
                                    {"userVersion": version, "baseImage": image, "profileId": profile, "warmSlots": 0,
                                     "runCommand": "docker run --entrypoint /usr/local/bin/node "
                                                   + shlex.quote(image) + " /opt/product/cocell/launcher.mjs"})
        if status != 202 or not isinstance(operation, dict) or not operation.get("id"):
            raise RuntimeError("Revision build submission was not confirmed; inspect Cellbox operations before retrying")
        operation_id = operation["id"]
        deadline = time.monotonic() + 1800
        while time.monotonic() < deadline:
            status, current = request(base, "/v1/operations/" + operation_id, client)
            if status != 200 or not isinstance(current, dict):
                raise RuntimeError(f"Cannot read submitted build operation {operation_id}; do not resubmit automatically")
            if current.get("status") in ("succeeded", "failed", "cancelled"):
                result = current.get("result") or {}
                revision_id = result.get("revisionId") if current.get("status") == "succeeded" else None
                if not revision_id:
                    raise RuntimeError(f"Build operation {operation_id} ended {current.get('status')}; inspect logs")
                selector_output = os.environ.get("COCELL_CELLBOX_SELECTOR_OUTPUT", "").strip()
                if selector_output:
                    write_selector(selector_output, family_id, revision_id)
                print("Build succeeded. Pin the tested revision in deploy.env and .env:")
                print(f"CELLBOX_REVISION_ID={revision_id}")
                print(f"# Optional moving family selector: CELLBOX_TEMPLATE_ID={family_id}")
                print(f"Build operation: {operation_id}")
                return 0
            time.sleep(2)
        raise RuntimeError(f"Build operation {operation_id} is still pending; inspect it without resubmitting")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # Do not print HTTP bodies or credential material.
        print(f"Cellbox template bootstrap stopped: {error}", file=sys.stderr)
        sys.exit(1)
