#!/usr/bin/env python3
"""Summarize a read-only kubectl CellBox export without emitting raw resource data."""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def safe_id(value: object) -> str | None:
    return value if isinstance(value, str) and SAFE_ID.fullmatch(value) else None


def inventory(document: object) -> dict:
    if not isinstance(document, dict) or not isinstance(document.get("items"), list):
        raise ValueError("input must be a Kubernetes list JSON with an items array")
    rows = []
    phases = Counter()
    versions = Counter()
    unknown = Counter()
    for item in document["items"]:
        if not isinstance(item, dict):
            unknown["invalidResource"] += 1
            continue
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        spec = item.get("spec") if isinstance(item.get("spec"), dict) else {}
        status = item.get("status") if isinstance(item.get("status"), dict) else {}
        container = spec.get("container") if isinstance(spec.get("container"), dict) else {}
        name = safe_id(metadata.get("name"))
        phase = safe_id(status.get("phase")) or "unknown"
        phases[phase] += 1
        if not name:
            unknown["unsafeOrMissingId"] += 1
            continue
        row = {"id": name, "phase": phase}
        for label, value in (("profileId", spec.get("profileId")),
                             ("templateId", spec.get("templateId")),
                             ("revisionId", spec.get("revisionId"))):
            parsed = safe_id(value)
            if parsed:
                row[label] = parsed
            elif value in (None, ""):
                unknown[label] += 1
            else:
                unknown[f"unsafe{label[0].upper()}{label[1:]}"] += 1
        for label, value in (("templateVersion", spec.get("templateVersion")),
                             ("revision", spec.get("revision")),
                             ("imageVersion", status.get("imageVersion"))):
            parsed = safe_id(value)
            if parsed:
                row[label] = parsed
                versions[parsed] += 1
            elif value not in (None, ""):
                unknown[f"unsafe{label[0].upper()}{label[1:]}"] += 1
        image = container.get("image")
        if isinstance(image, str) and image:
            # Keep only the digest; repository host/name can disclose installation details.
            digest = image.rsplit("@sha256:", 1)
            if len(digest) == 2 and re.fullmatch(r"[a-f0-9]{64}", digest[1]):
                row["imageDigest"] = "sha256:" + digest[1]
            else:
                unknown["imageReference"] += 1
        else:
            unknown["imageReference"] += 1
        rows.append(row)
    return {"source": "read-only Kubernetes CellBox CR export", "count": len(document["items"]),
            "phaseCounts": dict(sorted(phases.items())), "versionCounts": dict(sorted(versions.items())),
            "unknownCounts": dict(sorted(unknown.items())),
            "resources": rows,
            "scope": "CR inventory only; does not inspect or import SQLite metadata, archive indexes/payloads, checkpoints, HOME, workspaces, or operations."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="JSON export path; defaults to stdin (for kubectl get -o json)")
    args = parser.parse_args()
    try:
        raw = Path(args.input).read_text() if args.input else sys.stdin.read()
        result = inventory(json.loads(raw))
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Inventory failed: {error}", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
