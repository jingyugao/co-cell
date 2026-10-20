#!/usr/bin/env python3
"""Build, publish, and upgrade the single-process Cellbox server release."""

import sys

from cellbox_deploy import CellboxRelease


if len(sys.argv) != 2:
    raise SystemExit("usage: deploy-cellbox-server.py CELLBOX_SOURCE_DIR")

release = CellboxRelease(sys.argv[1])
values, _ = release.values()  # Validate profile, node, and isolated storage before publishing an image.
release.check_runtime(values)
image = release.publish_server()
release.deploy(image)
