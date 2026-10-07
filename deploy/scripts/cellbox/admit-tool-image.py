#!/usr/bin/env python3
"""Explicitly admit an inspected immutable tool image to the operator's profile."""
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'k8s'))
from cellbox_deploy import CellboxRelease

if len(sys.argv) not in (4, 5) or not re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', sys.argv[3]) or (len(sys.argv) == 5 and sys.argv[4] not in ('--mounted-tool-runtime', '--mounted-debug-home')):
    raise SystemExit('usage: admit-tool-image.py CELLBOX_SOURCE_DIR PROFILE_ID REPOSITORY@sha256:DIGEST [--mounted-tool-runtime|--mounted-debug-home]')
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
# Opt in only after inspecting an image built with the mounted-runtime runner.
# Existing immutable images keep the batch-delivery fallback during rollout.
if len(sys.argv) == 5:
    mounted = profile.setdefault('mountedToolRuntimeImages', [])
    if sys.argv[3] not in mounted:
        mounted.append(sys.argv[3])
    if sys.argv[4] == '--mounted-debug-home':
        if not profile.get('sharedReadOnlyHostPath'):
            raise SystemExit('Mounted debug HOME requires the shared directory')
        profile['debugReadWriteHostPath'] = profile['sharedReadOnlyHostPath'] + '/runtime/debug-homes'
        homes = profile.setdefault('debugHomeImages', [])
        if sys.argv[3] not in homes:
            homes.append(sys.argv[3])
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
