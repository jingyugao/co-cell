#!/usr/bin/env python3
"""Build, publish, and upgrade the Cellbox controller and node adapter with Helm."""

import sys
from cellbox_deploy import CellboxRelease

if len(sys.argv) != 2:
    raise SystemExit("usage: deploy-cellbox-controller.py CELLBOX_SOURCE_DIR")
release = CellboxRelease(sys.argv[1])
image = release.publish("controller")
release.check_lifecycle_operations()
# Keep controller spans in the API's collector while retaining controller-specific
# environment and service identity. Values remain installation-owned.
controller_env = list(release.values["controller"].get("extraEnv", []))
configured = {entry["name"] for entry in controller_env}
for entry in release.values["api"].get("extraEnv", []):
    name = entry["name"]
    if name.startswith("OTEL_") and name != "OTEL_SERVICE_NAME" and name not in configured:
        controller_env.append(entry)
release.upgrade({"controller": {"image": image, "adapterImage": image, "extraEnv": controller_env}})
release.verify("daemonset", release.values["controller"]["name"], image, release.namespace,
               ("controller", "install-runtime-adapter", "install-gvisor"))
