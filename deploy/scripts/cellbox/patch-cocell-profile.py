#!/usr/bin/env python3
"""Emit Helm overrides for CoCell's image, startup command and admitted tools."""

from copy import deepcopy
import json
import os
import posixpath
import re
import sys

from proxy_tools import load_proxy_tools

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
if read_only_path and read_write_path:
    raise SystemExit("Configure only one debug host mount mode")
for name, value in (("COCELL_DEBUG_READ_ONLY_HOST_PATH", read_only_path), ("COCELL_DEBUG_READ_WRITE_HOST_PATH", read_write_path)):
    if value and (not value.startswith("/") or value == "/" or posixpath.normpath(value) != value or any(char in value for char in "\x00\r\n")):
        raise SystemExit(f"{name} must be a clean absolute directory path")
guest = profile.setdefault("guest", {})
guest.setdefault("agent", sample["guest"]["agent"])
if not guest.get("debug", {}).get("uid"):
    guest["debug"] = sample["guest"]["debug"]
if read_write_path:
    uid, gid = os.environ.get("COCELL_DEBUG_HOST_UID", ""), os.environ.get("COCELL_DEBUG_HOST_GID", "")
    if not uid.isdecimal() or not gid.isdecimal() or not 0 < int(uid) < 2**32 or not 0 < int(gid) < 2**32:
        raise SystemExit("Set COCELL_DEBUG_HOST_UID and COCELL_DEBUG_HOST_GID to the host home owner")
    if int(uid) == guest["agent"]["uid"] or int(gid) == guest["agent"]["gid"]:
        raise SystemExit("Debug host identity must differ from the agent identity")
    guest["debug"] = {"uid": int(uid), "gid": int(gid)}
    profile.pop("debugReadOnlyHostPath", None)
    profile["debugReadWriteHostPath"] = read_write_path
elif read_only_path:
    profile.pop("debugReadWriteHostPath", None)
    profile["debugReadOnlyHostPath"] = read_only_path
guest["workspace"] = sample["guest"]["workspace"]
guest["command"] = sample["guest"]["command"]
guest["tools"] = [tool for tool in guest.get("tools", []) if tool["id"] not in owned_ids] + [tool["profile"] for tool in proxy_tools]
profile["image"] = image
json.dump({} if profile == before else {"api": {"config": config}}, sys.stdout)
