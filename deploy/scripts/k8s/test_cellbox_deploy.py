import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("cellbox_deploy.py")
SPEC = importlib.util.spec_from_file_location("cellbox_deploy", SCRIPT)
cellbox_deploy = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(cellbox_deploy)


class CellboxValuesMigrationTests(unittest.TestCase):
    def test_runtime_preflight_checks_configured_fork_capabilities(self):
        release = cellbox_deploy.CellboxRelease.__new__(cellbox_deploy.CellboxRelease)
        release.context = "k3s-test"
        release.namespace = "cell-box"
        runsc = "/usr/local/bin/gvisor-cellbox-dev/runsc"
        outputs = [
            subprocess.CompletedProcess(args=(), returncode=0, stdout="-restore-page-loading", stderr=""),
            subprocess.CompletedProcess(args=(), returncode=0, stdout="create: -no-root-container", stderr=""),
        ]
        with mock.patch.object(cellbox_deploy.subprocess, "run", side_effect=outputs) as run:
            release.check_runtime({"controller": {"runsc": runsc}})

        self.assertEqual(run.call_count, 2)
        calls = [call.args[0] for call in run.call_args_list]
        self.assertTrue(all(runsc in args for args in calls))
        self.assertEqual(calls[0][-1], "flags")
        self.assertEqual(calls[1][-2:], ("help", "create"))
        self.assertTrue(all("nsenter" in args and "--mount" in args and "--root" in args for args in calls))

    def test_runtime_preflight_rejects_legacy_runsc_without_no_root_support(self):
        release = cellbox_deploy.CellboxRelease.__new__(cellbox_deploy.CellboxRelease)
        release.context = "k3s-test"
        release.namespace = "cell-box"
        outputs = [
            subprocess.CompletedProcess(args=(), returncode=0, stdout="-restore-page-loading", stderr=""),
            subprocess.CompletedProcess(args=(), returncode=0, stdout="create options: legacy-only", stderr=""),
        ]
        with mock.patch.object(cellbox_deploy.subprocess, "run", side_effect=outputs) as run:
            with self.assertRaisesRegex(RuntimeError, "tested matching fork runsc/shim/wrapper.*existing checkpoints"):
                release.check_runtime({"controller": {}})

        self.assertEqual(run.call_count, 2)
        self.assertIn("/usr/local/bin/runsc", run.call_args_list[0].args[0])

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
        # Omitted values stay omitted so the chart's current defaults apply.
        self.assertNotIn("runtimeClass", values)
        self.assertNotIn("warmPoolSize", values["controller"])

    def test_deploy_preserves_isolated_runtime_configuration_with_reset_values(self):
        runtime_class = {"create": True, "name": "runsc-cellbox-dev", "handler": "runsc-cellbox-dev"}
        controller = {
            "warmPoolSize": 0,
            "nodeBase": "/var/lib/gvisor-cellbox-dev",
            "runsc": "/usr/local/bin/gvisor-cellbox-dev/4320a3de3afb/runsc",
            "shim": "/usr/local/bin/gvisor-cellbox-dev/4320a3de3afb/containerd-shim-runsc-v1",
        }
        existing = {
            "server": {"nodeName": "runtime-node"},
            "api": {"manageSecrets": False, "config": {"clientId": "cocell-client"}},
            "runtimeClass": runtime_class,
            "crd": {"create": False},
            "controller": controller,
            "storage": {"hostPath": "/srv/cellbox-v2-data", "existingClaim": ""},
            "objectStorage": {"endpoint": "https://objects.example", "bucket": "cellbox-data", "prefix": "cocell-cellbox-v2"},
        }
        release = cellbox_deploy.CellboxRelease.__new__(cellbox_deploy.CellboxRelease)
        release.release = "cellbox"
        release.context = "k3s-test"
        release.namespace = "cell-box"
        release.profile_id = "profile-small"
        release.node_name = "runtime-node"
        release.storage_host_path = ""
        release.storage_claim = ""
        release.object_prefix = ""
        release.check_lifecycle_operations = mock.Mock()
        with tempfile.TemporaryDirectory() as source:
            release.source = Path(source)
            release.chart = release.source / "charts/cellbox"
            release.chart.mkdir(parents=True)

            helm_values = subprocess.CompletedProcess(args=("helm", "get", "values"), returncode=0,
                                                      stdout=json.dumps(existing), stderr="")
            image = "registry.example/cellbox-server@sha256:" + "a" * 64
            deployment = {"spec": {"replicas": 1, "template": {"spec": {"containers": [
                {"name": "server", "image": image},
            ]}}}}
            pods = {"items": [{"metadata": {}, "status": {"phase": "Running", "containerStatuses": [
                {"name": "server", "ready": True, "imageID": "docker-pullable://" + image},
            ]}}]}
            deployed_values = {}

            def fake_run(*args, capture=False, check=True):
                if args[:2] == ("helm", "template"):
                    value_path = Path(args[args.index("--values") + 1])
                    deployed_values.update(json.loads(value_path.read_text()))
                elif args[:2] == ("helm", "upgrade"):
                    self.assertIn("--reset-values", args)
                elif args[:3] == ("kubectl", "--context", "k3s-test") and "get" in args and "deployment" in args:
                    return json.dumps(deployment)
                elif args[:3] == ("kubectl", "--context", "k3s-test") and "get" in args and "pods" in args:
                    return json.dumps(pods)
                return ""

            with mock.patch.object(cellbox_deploy.subprocess, "run", return_value=helm_values), \
                    mock.patch.object(cellbox_deploy, "run", side_effect=fake_run):
                release.deploy(image)

        self.assertEqual(deployed_values["runtimeClass"], runtime_class)
        self.assertEqual(deployed_values["crd"], {"create": False})
        self.assertEqual(deployed_values["controller"]["nodeBase"], controller["nodeBase"])
        self.assertEqual(deployed_values["controller"]["runsc"], controller["runsc"])
        self.assertEqual(deployed_values["controller"]["shim"], controller["shim"])
        self.assertEqual(deployed_values["controller"]["warmPoolSize"], 0)
        self.assertEqual(deployed_values["storage"], existing["storage"])
        self.assertEqual(deployed_values["objectStorage"]["prefix"], existing["objectStorage"]["prefix"])


if __name__ == "__main__":
    unittest.main()
