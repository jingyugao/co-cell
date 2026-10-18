import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("cellbox_deploy.py")
SPEC = importlib.util.spec_from_file_location("cellbox_deploy", SCRIPT)
cellbox_deploy = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(cellbox_deploy)


class CellboxValuesMigrationTests(unittest.TestCase):
    def test_legacy_values_drop_public_url_preserve_supported_config_and_rewrite_isolated_storage(self):
        legacy = {
            "imageRegistry": "operator-registry.example",
            "buildkit": {
                "enabled": True,
                "image": "moby/buildkit:v0.33.0-rootless",
                "repository": "operator/cellbox-images",
                "extraEnv": [{"name": "BUILDKIT_PROXY", "value": "http://proxy.internal"}],
            },
            "api": {
                "initImage": "library/busybox:1.36",
                "sidecar": {"name": "buildkit", "image": "moby/buildkit:v0.33.0-rootless"},
                "config": {
                    "publicUrl": "https://old-cellbox.example",
                    "clientId": "cocell-client",
                    "profiles": [{"id": "profile-small", "nodeName": "runtime-node"}],
                    "node": {"name": "kept-node-config"},
                },
            },
            "objectStorage": {
                "endpoint": "https://objects.example",
                "bucket": "cellbox-data",
                "prefix": "legacy-prefix",
                "credentialsSecret": "cellbox-object-credentials",
            },
            # Legacy release has neither server.nodeName nor storage configured.
        }
        before = copy.deepcopy(legacy)
        result = subprocess.CompletedProcess(args=("helm", "get", "values"), returncode=0,
                                             stdout=json.dumps(legacy), stderr="")
        release = cellbox_deploy.CellboxRelease.__new__(cellbox_deploy.CellboxRelease)
        release.release = "cellbox"
        release.context = "k3s-test"
        release.namespace = "cell-box"
        release.profile_id = "profile-small"
        release.node_name = "runtime-node"
        release.storage_host_path = "/srv/cellbox-v2-data"
        release.storage_claim = ""
        release.object_prefix = "cocell-cellbox-v2/"

        with mock.patch.object(cellbox_deploy.subprocess, "run", return_value=result) as run:
            values, existing = release.values()

        run.assert_called_once_with(
            ("helm", "get", "values", "cellbox", "--kube-context", "k3s-test",
             "--namespace", "cell-box", "--all", "--output", "json"),
            check=False, text=True, stdout=subprocess.PIPE,
        )
        self.assertEqual(existing, before)
        self.assertNotIn("publicUrl", values["api"]["config"])
        self.assertEqual(values["api"]["config"], {
            "clientId": "cocell-client",
            "profiles": [{"id": "profile-small", "nodeName": "runtime-node"}],
            "node": {"name": "kept-node-config"},
            "dataDir": "/var/lib/cellbox-data",
        })
        self.assertEqual(values["api"]["initImage"], "library/busybox:1.36")
        self.assertEqual(values["imageRegistry"], "operator-registry.example")
        self.assertEqual(values["buildkit"], before["buildkit"])
        self.assertEqual(values["objectStorage"]["prefix"], "cocell-cellbox-v2")
        self.assertEqual(values["storage"], {"hostPath": "/srv/cellbox-v2-data", "existingClaim": ""})
        self.assertEqual(values["server"]["nodeName"], "runtime-node")


if __name__ == "__main__":
    unittest.main()
