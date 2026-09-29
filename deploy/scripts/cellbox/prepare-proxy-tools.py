#!/usr/bin/env python3
"""Generate image wrappers and policy payloads from a local MyBox config."""

import json
import os
import shlex
import shutil
import sys
from pathlib import Path

from proxy_tools import load_proxy_tools


config_path, base_image, output_path = sys.argv[1:]
tools, _ = load_proxy_tools(config_path, base_image, required=bool(os.environ.get("COCELL_PROXY_TOOLS_CONFIG")))
output = Path(output_path)
if tools:
    wrappers = output / "wrappers"
    policies = output / "proxy-policies"
    wrappers.mkdir(parents=True)
    policies.mkdir(parents=True)
    (output / "proxy-tool-ids.json").write_text(json.dumps([tool["profile"]["id"] for tool in tools]))
    for tool in tools:
        name = tool["name"]
        tool_id = tool["profile"]["id"]
        wrapper = wrappers / name
        wrapper.write_text(
            "#!/bin/sh\nexec /usr/local/bin/node /opt/product/cocell/tool-client.mjs "
            + shlex.quote(tool_id) + ' "$@"\n'
        )
        wrapper.chmod(0o755)
        policy = tool["policy_path"]
        if policy is not None:
            destination = policies / policy.name
            if not destination.exists():
                shutil.copyfile(policy, destination)
                destination.chmod(0o755)
print(" ".join(tool["name"] for tool in tools))
