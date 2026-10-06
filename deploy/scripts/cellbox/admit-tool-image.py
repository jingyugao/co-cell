#!/usr/bin/env python3
"""Explicitly admit an inspected immutable tool image to the operator's profile."""
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'k8s'))
from cellbox_deploy import CellboxRelease

if len(sys.argv) != 4 or not re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', sys.argv[3]):
    raise SystemExit('usage: admit-tool-image.py CELLBOX_SOURCE_DIR PROFILE_ID REPOSITORY@sha256:DIGEST')
release = CellboxRelease(sys.argv[1])
config = release.values['api']['config']
if not release.values['api'].get('manageSecrets', True):
    raise SystemExit('API configuration is externally managed; update it through its owner')
profiles = [p for p in config['profiles'] if p['id'] == sys.argv[2]]
if len(profiles) != 1:
    raise SystemExit('Expected exactly one profile')
profile = profiles[0]
trusted = profile.setdefault('trustedToolImages', [])
if sys.argv[3] not in trusted:
    trusted.append(sys.argv[3])
tools = profile['guest'].setdefault('tools', [])
names = json.loads((Path(__file__).resolve().parents[2] / 'box-wrap/proxy-tools.json').read_text())
for name in names:
    tool_id = 'cocell_' + name.replace('-', '_')
    if not any(tool['id'] == tool_id for tool in tools):
        tools.append({'id': tool_id, 'executable': '/opt/cellbox/tools/cocell-proxy', 'args': [name, '-'],
                      'passThroughArgs': True, 'credentialEnv': {'COCELL_TOOL_RUNTIME': 'cocell_tool_runtime'}})
for tool in tools:
    if tool['id'] in ('cocell_git', 'cocell_glab'):
        tool['workspaceRead'] = True
        tool['workspaceWrite'] = True
release.check_lifecycle_operations()
release.upgrade({'api': {'config': config}})
print('Admitted inspected image:', sys.argv[3])
