#!/usr/bin/env python3
"""Build, publish, and upgrade the Cellbox controller and node adapter with Helm."""

import sys
from cellbox_deploy import CellboxRelease

if len(sys.argv) != 2:
    raise SystemExit("usage: deploy-cellbox-controller.py CELLBOX_SOURCE_DIR")
release = CellboxRelease(sys.argv[1])
image = release.publish("controller")
release.check_lifecycle_operations()
release.upgrade({"controller": {"image": image, "adapterImage": image}})
release.verify("daemonset", release.values["controller"]["name"], image, release.namespace,
               ("controller", "install-runtime-adapter", "install-gvisor"))
