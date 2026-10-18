#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  all)
    make deploy-cellbox-server
    work="$(mktemp -d)"
    chmod 700 "$work"
    trap 'rm -rf -- "$work"' EXIT
    selector="$work/cellbox-selector.json"
    COCELL_CELLBOX_SELECTOR_OUTPUT="$selector" make deploy-cocell-sandbox
    revision_id="$(jq -er '. as $selector | select(($selector.templateId | type) == "string" and ($selector.revisionId | type) == "string") | .revisionId | select(length > 0)' "$selector")"
    CELLBOX_TEMPLATE_ID='' CELLBOX_REVISION_ID="$revision_id" make deploy-co-cell
    ;;
  debug)
    make deploy-cellbox-server
    make deploy-cocell-sandbox
    ;;
  *)
    echo "usage: $0 {all|debug}" >&2
    exit 2
    ;;
esac
