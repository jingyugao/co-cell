#!/usr/bin/env python3
"""Emit a guarded Secret patch for CoCell's image and owned Cellbox tools."""

import base64
import json
import os
import posixpath
import sys

from proxy_tools import load_proxy_tools

profile_id, image, sample_path, proxy_config, base_image = sys.argv[1:]
secret = json.load(sys.stdin)
config = json.loads(base64.b64decode(secret["data"]["config.json"]))
profiles = [profile for profile in config["profiles"] if profile["id"] == profile_id]
if len(profiles) != 1:
    raise SystemExit("expected exactly one Cellbox profile")
profile = profiles[0]
with open(sample_path, encoding="utf-8") as stream:
    sample = json.load(stream)
proxy_tools, owned_ids = load_proxy_tools(proxy_config, base_image, required=bool(os.environ.get("COCELL_PROXY_TOOLS_CONFIG")))
desired = [tool["profile"] for tool in proxy_tools]
read_only_path = os.environ.get("COCELL_DEBUG_READ_ONLY_HOST_PATH", "")
read_write_path = os.environ.get("COCELL_DEBUG_READ_WRITE_HOST_PATH", "")
old_read_only_path = profile.get("debugReadOnlyHostPath", "")
old_read_write_path = profile.get("debugReadWriteHostPath", "")
old_debug = dict(profile["guest"]["debug"])
old_workspace = profile["guest"]["workspace"]
if read_only_path and read_write_path:
    raise SystemExit("Configure only one debug host mount mode")
for name, value in (("COCELL_DEBUG_READ_ONLY_HOST_PATH", read_only_path), ("COCELL_DEBUG_READ_WRITE_HOST_PATH", read_write_path)):
    if value and (not value.startswith("/") or value == "/" or posixpath.normpath(value) != value or any(char in value for char in "\x00\r\n")):
        raise SystemExit(f"{name} must be a clean absolute directory path")
if read_write_path:
    uid, gid = os.environ.get("COCELL_DEBUG_HOST_UID", ""), os.environ.get("COCELL_DEBUG_HOST_GID", "")
    if not uid.isdecimal() or not gid.isdecimal() or not 0 < int(uid) < 2**32 or not 0 < int(gid) < 2**32:
        raise SystemExit("Set COCELL_DEBUG_HOST_UID and COCELL_DEBUG_HOST_GID to the host home owner")
    agent = profile["guest"]["agent"]
    if int(uid) == agent["uid"] or int(gid) == agent["gid"]:
        raise SystemExit("Debug host identity must differ from the agent identity")
    profile["guest"]["debug"] = {"uid": int(uid), "gid": int(gid)}
    profile.pop("debugReadOnlyHostPath", None)
    profile["debugReadWriteHostPath"] = read_write_path
elif read_only_path:
    profile.pop("debugReadWriteHostPath", None)
    profile["debugReadOnlyHostPath"] = read_only_path
profile["guest"]["workspace"] = sample["guest"]["workspace"]
tools = profile["guest"].setdefault("tools", [])
updated = [tool for tool in tools if tool["id"] not in owned_ids] + desired
if (profile["image"] == image and tools == updated and
        profile.get("debugReadOnlyHostPath", "") == old_read_only_path and
        profile.get("debugReadWriteHostPath", "") == old_read_write_path and
        profile["guest"]["debug"] == old_debug and
        profile["guest"]["workspace"] == old_workspace):
    print("[]")
    raise SystemExit(0)
profile["image"] = image
profile["guest"]["tools"] = updated
encoded = base64.b64encode(json.dumps(config, separators=(",", ":")).encode()).decode()
json.dump([
    {"op": "test", "path": "/metadata/resourceVersion", "value": secret["metadata"]["resourceVersion"]},
    {"op": "replace", "path": "/data/config.json", "value": encoded},
], sys.stdout)
