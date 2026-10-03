#!/usr/bin/env python3
"""Emit Helm overrides for CoCell's image, startup command and admitted tools."""

from copy import deepcopy
import json
import os
import re
import sys

from proxy_tools import load_proxy_tools
from mount_config import load_mount_config

profile_id, image, sample_path, proxy_config, base_image = sys.argv[1:]
if not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", image):
    raise SystemExit("CoCell requires an immutable repository@sha256:digest image")
values = json.load(sys.stdin)
if not values["api"].get("manageSecrets", True):
    raise SystemExit("This profile updater requires api.manageSecrets=true; update externally managed Cellbox config through its owner")
config = values["api"]["config"]
profiles = [profile for profile in config.get("profiles", []) if profile["id"] == profile_id]
if len(profiles) != 1:
    raise SystemExit("Configure exactly one CoCell profile in the Cellbox Helm values first")
profile = profiles[0]
if profile["provider"] != "resumable-k8s-pod":
    raise SystemExit("CoCell requires a resumable Kubernetes profile")
before = deepcopy(profile)
with open(sample_path, encoding="utf-8") as stream:
    sample = json.load(stream)
proxy_tools, owned_ids = load_proxy_tools(proxy_config, base_image, required=bool(os.environ.get("COCELL_PROXY_TOOLS_CONFIG")))
read_only_path = os.environ.get("COCELL_DEBUG_READ_ONLY_HOST_PATH", "")
read_write_path = os.environ.get("COCELL_DEBUG_READ_WRITE_HOST_PATH", "")
if read_only_path or read_write_path:
    raise SystemExit("Project Secret management requires isolated debug homes; remove debug host mount options")
shared = load_mount_config()
if shared is not None:
    if shared["enabled"]:
        if shared["nodeName"] != profile["nodeName"]:
            raise SystemExit("Mount config nodeName must match the Cellbox profile nodeName")
        profile["sharedReadOnlyHostPath"] = shared["hostPath"]
    else:
        profile.pop("sharedReadOnlyHostPath", None)
profile.pop("debugReadOnlyHostPath", None)
profile.pop("debugReadWriteHostPath", None)
guest = profile.setdefault("guest", {})
guest.setdefault("agent", sample["guest"]["agent"])
guest["debug"] = sample["guest"]["debug"]
guest.pop("debugHome", None)
guest["workspace"] = sample["guest"]["workspace"]
guest["command"] = sample["guest"]["command"]
if profile.get("sharedReadOnlyHostPath"):
    guest.setdefault("env", {})["COCELL_LAUNCHER_SHARED_DIRECTORY"] = "/var/lib/cellbox/shared"
else:
    guest.setdefault("env", {}).pop("COCELL_LAUNCHER_SHARED_DIRECTORY", None)
guest["tools"] = [tool for tool in guest.get("tools", []) if tool["id"] not in owned_ids] + [tool["profile"] for tool in proxy_tools]
profile["image"] = image
json.dump({} if profile == before else {"api": {"config": config}}, sys.stdout)
