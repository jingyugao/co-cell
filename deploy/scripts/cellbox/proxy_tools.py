"""Load locally configured Cellbox CLI proxies without bundling user policy in Git."""

import re
import tomllib
from pathlib import Path


NAME = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
TOOL_ID = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z")


def load_proxy_tools(config_path: str, base_image: str, *, required: bool = False) -> tuple[list[dict], set[str]]:
    path = Path(config_path)
    if not path.is_file():
        if required:
            raise ValueError(f"proxy tool config does not exist: {path}")
        return [], set()
    with path.open("rb") as stream:
        config = tomllib.load(stream)
    managed = config.get("proxy_tool_ids", [])
    if (not isinstance(managed, list) or not all(isinstance(item, str) and TOOL_ID.fullmatch(item) for item in managed)
            or len(managed) != len(set(managed))):
        raise ValueError("proxy_tool_ids must contain unique tool IDs")
    configured_image = config.get("sandbox", {}).get("image")
    if configured_image != base_image:
        if required:
            raise ValueError(f"proxy tool config image {configured_image!r} does not match {base_image!r}")
        return [], set(managed)
    configured_tools = config.get("proxy_tools", {})
    if not isinstance(configured_tools, dict):
        raise ValueError("proxy_tools must be a TOML table")
    tools = []
    ids = set()
    for name, spec in sorted(configured_tools.items()):
        if not NAME.fullmatch(name) or not isinstance(spec, dict):
            raise ValueError(f"invalid proxy tool name: {name!r}")
        unknown = set(spec) - {"id", "policy", "allow_unrestricted"}
        if unknown:
            raise ValueError(f"unknown proxy tool options for {name}: {', '.join(sorted(unknown))}")
        tool_id = spec.get("id")
        if not isinstance(tool_id, str) or not TOOL_ID.fullmatch(tool_id) or tool_id in ids:
            raise ValueError(f"invalid or duplicate proxy tool ID: {tool_id!r}")
        ids.add(tool_id)
        policy = spec.get("policy")
        unrestricted = spec.get("allow_unrestricted", False)
        if not isinstance(unrestricted, bool) or (policy is None and not unrestricted) or (policy is not None and unrestricted):
            raise ValueError(f"{name} must have a policy or explicitly allow unrestricted arguments")
        policy_path = None
        if policy is not None:
            if not isinstance(policy, str) or not policy.startswith("proxy-tools/"):
                raise ValueError(f"invalid policy path for {name}")
            policy_path = (path.parent / policy).resolve()
            policy_root = (path.parent / "proxy-tools").resolve()
            if (policy_path.parent != policy_root or not policy_path.is_file()
                    or not NAME.fullmatch(policy_path.name)):
                raise ValueError(f"invalid policy file for {name}")
        tools.append({
            "name": name,
            "policy_path": policy_path,
            "profile": {
                "id": tool_id,
                "executable": "/opt/cellbox/tools/cocell-proxy",
                "args": [name, policy_path.name if policy_path else "-"],
                "passThroughArgs": True,
            },
        })
    if not managed:
        managed = list(ids)
    if not ids.issubset(managed):
        raise ValueError("proxy_tool_ids must list each configured proxy tool ID")
    return tools, set(managed)
