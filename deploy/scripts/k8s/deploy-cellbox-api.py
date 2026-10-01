#!/usr/bin/env python3
"""Build, publish, and upgrade the Cellbox API through its Helm release."""

import sys
from cellbox_deploy import CellboxRelease

if len(sys.argv) != 2:
    raise SystemExit("usage: deploy-cellbox-api.py CELLBOX_SOURCE_DIR")
release = CellboxRelease(sys.argv[1])
image = release.publish("api")
release.check_lifecycle_operations()
release.upgrade({"api": {"image": image}})
release.verify("deployment", "cellbox-api", image, release.api_namespace, ("api",))
