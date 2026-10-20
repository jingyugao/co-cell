import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("bootstrap-template.py")
SPEC = importlib.util.spec_from_file_location("bootstrap_template", SCRIPT)
bootstrap = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(bootstrap)


IMAGE = "registry.example/cocell@sha256:" + "a" * 64


class BootstrapTemplateTests(unittest.TestCase):
    def setUp(self):
        self.environment = mock.patch.dict(os.environ, {
            "CELLBOX_PROFILE": "profile-small",
            "CELLBOX_CLIENT_ID": "cocell-test",
            "CELLBOX_TEMPLATE_ID": "template-system",
            "CELLBOX_REVISION_ID": "",
            "COCELL_CELLBOX_CREATE_TEMPLATE": "",
            "COCELL_CELLBOX_LOCAL_PORT": "18090",
            "COCELL_SANDBOX_IMAGE_TAG": "v2.3.4",
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.argv = mock.patch.object(sys, "argv", [str(SCRIPT), IMAGE])
        self.argv.start()
        self.addCleanup(self.argv.stop)

        self.port_forward = mock.Mock()
        self.port_forward.poll.return_value = None
        self.popen = mock.patch.object(bootstrap.subprocess, "Popen", return_value=self.port_forward)
        self.popen_mock = self.popen.start()
        self.addCleanup(self.popen.stop)

        health = mock.MagicMock()
        health.__enter__.return_value.status = 200
        self.healthz = mock.patch.object(bootstrap.urllib.request, "urlopen", return_value=health)
        self.healthz.start()
        self.addCleanup(self.healthz.stop)

    def test_confirmed_build_writes_selector_after_correct_launcher_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            selector = Path(directory) / "selector.json"
            os.environ["COCELL_CELLBOX_SELECTOR_OUTPUT"] = str(selector)
            calls = []

            def request(_base, path, _client, method="GET", payload=None):
                calls.append((path, method, payload))
                if path == "/v1/profiles":
                    return 200, [{"id": "profile-small"}]
                if path == "/v1/templates/template-system":
                    return 200, {"id": "template-system"}
                if path == "/v1/templates/template-system/revisions" and method == "POST":
                    return 202, {"id": "operation-123"}
                if path == "/v1/operations/operation-123":
                    return 200, {"status": "succeeded", "result": {"revisionId": "revision-456"}}
                self.fail(f"Unexpected Cellbox request: {method} {path}")

            with mock.patch.object(bootstrap, "request", side_effect=request):
                with mock.patch("sys.stdout"):
                    self.assertEqual(bootstrap.main(), 0)

            revision_posts = [call for call in calls if call[0] == "/v1/templates/template-system/revisions"]
            self.assertEqual(len(revision_posts), 1)
            self.assertEqual(revision_posts[0][1], "POST")
            self.assertEqual(revision_posts[0][2], {
                "userVersion": "2.3.4",
                "baseImage": IMAGE,
                "profileId": "profile-small",
                "warmSlots": 1,
                "runCommand": f"docker run --entrypoint /usr/local/bin/node {IMAGE} /opt/product/cocell/launcher.mjs",
            })
            self.assertTrue(selector.is_file())
            self.assertEqual(json.loads(selector.read_text()), {
                "templateId": "template-system",
                "revisionId": "revision-456",
            })
            operation_reads = [call for call in calls if call[0] == "/v1/operations/operation-123"]
            self.assertEqual(len(operation_reads), 1)

    def test_unconfirmed_revision_submission_is_not_polled_retried_or_pinned(self):
        with tempfile.TemporaryDirectory() as directory:
            selector = Path(directory) / "selector.json"
            os.environ["COCELL_CELLBOX_SELECTOR_OUTPUT"] = str(selector)
            calls = []

            def request(_base, path, _client, method="GET", payload=None):
                calls.append((path, method, payload))
                if path == "/v1/profiles":
                    return 200, [{"id": "profile-small"}]
                if path == "/v1/templates/template-system":
                    return 200, {"id": "template-system"}
                if path == "/v1/templates/template-system/revisions" and method == "POST":
                    return 502, None
                self.fail(f"Unexpected follow-up after uncertain submit: {method} {path}")

            with mock.patch.object(bootstrap, "request", side_effect=request):
                with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                    bootstrap.main()

            submissions = [call for call in calls if call[0] == "/v1/templates/template-system/revisions"]
            self.assertEqual(len(submissions), 1)
            self.assertEqual(submissions[0][1], "POST")
            self.assertEqual(len(calls), 3)
            self.assertFalse(selector.exists())

    def test_new_template_uses_same_default_and_revision_warm_slots(self):
        os.environ["CELLBOX_TEMPLATE_ID"] = ""
        os.environ["COCELL_CELLBOX_CREATE_TEMPLATE"] = "1"
        calls = []

        def request(_base, path, _client, method="GET", payload=None):
            calls.append((path, method, payload))
            if path == "/v1/profiles":
                return 200, [{"id": "profile-small"}]
            if path == "/v1/templates" and method == "POST":
                return 201, {"id": "template-created"}
            if path == "/v1/templates/template-created/revisions" and method == "POST":
                return 202, {"id": "operation-123"}
            if path == "/v1/operations/operation-123":
                return 200, {"status": "succeeded", "result": {"revisionId": "revision-456"}}
            self.fail(f"Unexpected Cellbox request: {method} {path}")

        with mock.patch.object(bootstrap, "request", side_effect=request):
            with mock.patch("sys.stdout"):
                self.assertEqual(bootstrap.main(), 0)

        template_posts = [call for call in calls if call[0] == "/v1/templates"]
        revision_posts = [call for call in calls if call[0] == "/v1/templates/template-created/revisions"]
        self.assertEqual(template_posts[0][2]["defaultWarmSlots"], 1)
        self.assertEqual(revision_posts[0][2]["warmSlots"], 1)

    def test_explicit_zero_disables_warm_slots_for_new_template_and_revision(self):
        os.environ["CELLBOX_TEMPLATE_ID"] = ""
        os.environ["COCELL_CELLBOX_CREATE_TEMPLATE"] = "1"
        os.environ["COCELL_CELLBOX_WARM_SLOTS"] = "0"

        def request(_base, path, _client, method="GET", payload=None):
            if path == "/v1/profiles":
                return 200, [{"id": "profile-small"}]
            if path == "/v1/templates" and method == "POST":
                self.assertEqual(payload["defaultWarmSlots"], 0)
                return 201, {"id": "template-created"}
            if path == "/v1/templates/template-created/revisions" and method == "POST":
                self.assertEqual(payload["warmSlots"], 0)
                return 202, {"id": "operation-123"}
            if path == "/v1/operations/operation-123":
                return 200, {"status": "succeeded", "result": {"revisionId": "revision-456"}}
            self.fail(f"Unexpected Cellbox request: {method} {path}")

        with mock.patch.object(bootstrap, "request", side_effect=request):
            with mock.patch("sys.stdout"):
                self.assertEqual(bootstrap.main(), 0)

    def test_invalid_warm_slots_is_rejected_before_network_or_port_forward(self):
        for invalid in ("", "-1", "+1", "1.5", "abc", " 1"):
            with self.subTest(value=invalid):
                os.environ["COCELL_CELLBOX_WARM_SLOTS"] = invalid
                with mock.patch.object(bootstrap, "request") as request_mock:
                    with self.assertRaisesRegex(SystemExit, "non-negative integer"):
                        bootstrap.main()
                self.popen_mock.assert_not_called()
                request_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
