"""Read the shared mount values used by both CoCell and Cellbox deployment."""
import json
import os
from pathlib import Path


def load_mount_config():
    default = Path(__file__).resolve().parents[2] / "local/mounts.json"
    location = os.environ.get("COCELL_MOUNTS_CONFIG")
    path = Path(location) if location else default
    if not location and not path.exists():
        return None
    with path.open(encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, dict) or set(data) != {"sharedDirectory"}:
        raise SystemExit("Mount config must contain only sharedDirectory")
    shared = data["sharedDirectory"]
    if not isinstance(shared, dict) or set(shared) != {"enabled", "hostPath", "nodeName"} or type(shared["enabled"]) is not bool:
        raise SystemExit("sharedDirectory requires enabled (boolean), hostPath and nodeName")
    host, node = shared["hostPath"], shared["nodeName"]
    if not isinstance(host, str) or not isinstance(node, str):
        raise SystemExit("hostPath and nodeName must be strings")
    if shared["enabled"] and (not os.path.isabs(host) or os.path.normpath(host) != host or host == "/" or len(host) > 4096 or any(c in host for c in "\x00\r\n") or not node.strip()):
        raise SystemExit("Enabled mount requires a clean absolute directory other than / and the Cellbox nodeName")
    return shared


if __name__ == "__main__":
    shared = load_mount_config()
    print("1" if shared and shared["enabled"] else "0")
