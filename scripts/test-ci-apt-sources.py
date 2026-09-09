#!/usr/bin/env python3
"""Fast source/retry fixtures. All sudo, APT and Playwright commands are fakes."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("apt_sources", HERE / "ci-isolate-chrome-source.py")
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)
CHROME = "https://dl.google.com/linux/chrome-stable/deb/"


class AptSourcesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="colony-apt-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sources = self.root / "etc/apt/sources.list.d"
        self.sources.mkdir(parents=True)
        (self.root / "etc/os-release").write_text('ID="ubuntu"\nVERSION_ID="24.04"\n')
        self.chrome = self.sources / "google-chrome.list"
        self.original = f"deb [arch=amd64 signed-by=/etc/apt/keyrings/google.gpg] {CHROME} stable main\n"
        self.chrome.write_text(self.original)
        self.env = {
            **os.environ, "APT_ROOT": str(self.root), "GITHUB_ACTIONS": "true",
            "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
        }

    def invoke(self, **overrides):
        return subprocess.run([sys.executable, str(HERE / "ci-isolate-chrome-source.py")],
                              env={**self.env, **overrides}, capture_output=True, text=True)

    def test_exact_uri_isolation_preserves_other_sources(self):
        unaffected = (
            "deb mirror+file:/etc/apt/apt-mirrors.txt noble main universe\n"
            "deb https://packages.microsoft.com/ubuntu/24.04/prod noble main\n"
            "deb https://dl.google.com.evil.example/linux/chrome/deb stable main\n"
            "deb https://dl.google.com/linux/chrome/deb-extra stable main\n"
            "deb https://dl.google.com/linux/earth/deb stable main\n"
            "deb https://dl.google.com/linux/chrome/deb?other=1 stable main\n"
            "# deb https://dl.google.com/linux/chrome/deb stable main\n"
        )
        source = self.root / "etc/apt/sources.list"
        source.write_text(unaffected + "deb-src http://dl.google.com/linux/chrome/deb stable main\n")
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(source.read_text().startswith(unaffected))
        self.assertIn("# Colony CI:", source.read_text()[len(unaffected):])
        self.assertEqual(self.chrome.read_text(), "# Colony CI: unrelated Chrome source disabled: " + self.original)

    def test_deb822_stanzas_preserve_keys_and_unrelated_sources(self):
        ubuntu = "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble noble-security\nComponents: main\n"
        chrome = f"Types: deb\nURIs: {CHROME}\nSuites: stable\nComponents: main\nSigned-By: /etc/keyrings/google.gpg\n"
        path = self.sources / "mixed-file.sources"
        path.write_text(ubuntu + "\n" + chrome)
        self.assertEqual(self.invoke().returncode, 0)
        self.assertEqual(path.read_text(), ubuntu + "\nEnabled: no\n" + chrome)
        path.write_text("Enabled: yes\n" + chrome)
        self.assertEqual(self.invoke().returncode, 0)
        self.assertEqual(path.read_text(), "Enabled: no\n" + chrome)

    def test_mixed_uri_stanza_fails_before_any_write(self):
        path = self.sources / "mixed.sources"
        original = f"Types: deb\nURIs: {CHROME}\n https://archive.ubuntu.com/ubuntu\nSuites: stable\n"
        path.write_text(original)
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mixed Chrome/non-Chrome", result.stderr)
        self.assertEqual(path.read_text(), original)
        self.assertEqual(self.chrome.read_text(), self.original)

    def test_idempotent_and_non_source_files_untouched(self):
        backup = self.sources / "google-chrome.list.save"
        backup.write_text(self.original)
        self.assertEqual(self.invoke().returncode, 0)
        first = self.chrome.read_bytes()
        self.assertEqual(self.invoke().returncode, 0)
        self.assertEqual(self.chrome.read_bytes(), first)
        self.assertEqual(backup.read_text(), self.original)

    def test_noop_outside_hosted_ubuntu(self):
        for override in [{"GITHUB_ACTIONS": "false"}, {"RUNNER_ENVIRONMENT": "self-hosted"}, {"RUNNER_OS": "macOS"}]:
            with self.subTest(override=override):
                self.assertEqual(self.invoke(**override).returncode, 0)
                self.assertEqual(self.chrome.read_text(), self.original)
        (self.root / "etc/os-release").write_text("ID=debian\n")
        self.assertEqual(self.invoke().returncode, 0)
        self.assertEqual(self.chrome.read_text(), self.original)

    def test_write_failure_returns_nonzero(self):
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(
            HELPER, "write_source", side_effect=OSError("fixture write failure")
        ), contextlib.redirect_stderr(io.StringIO()) as output:
            self.assertEqual(HELPER.main(), 1)
        self.assertIn("fixture write failure", output.getvalue())
        self.assertEqual(self.chrome.read_text(), self.original)

    def wrapper(self, name, **overrides):
        scripts = self.root / "scripts"
        binary = self.root / "bin"
        scripts.mkdir(exist_ok=True)
        binary.mkdir(exist_ok=True)
        for filename in ["ci-apt-install.sh", "ci-playwright-deps.sh", "ci-isolate-chrome-source.py"]:
            shutil.copyfile(HERE / filename, scripts / filename)
        stubs = {
            scripts / "ci-run-until-idle.sh": 'shift\nexec "$@"\n',
            scripts / "ci-drop-azure-mirror.sh": 'exit 0\n',
            binary / "sudo": 'exec "$@"\n',
            binary / "apt-get": '''printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "${FAIL_ACTIVE_CHROME:-0}" = 1 ] && grep -q '^deb ' "$APT_ROOT/etc/apt/sources.list.d/google-chrome.list"; then exit 41; fi
if [ "$1" = update ]; then exit "${APT_UPDATE_EXIT:-0}"; fi
exit "${APT_INSTALL_EXIT:-0}"
''',
            binary / "pnpm": 'printf \'%s\\n\' "$*" >> "$CALL_LOG"\nexit "${PLAYWRIGHT_EXIT:-0}"\n',
        }
        for path, body in stubs.items():
            path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
            path.chmod(0o755)
        log = self.root / "calls.log"
        log.unlink(missing_ok=True)
        env = {
            **self.env, "PATH": str(binary) + os.pathsep + os.environ["PATH"], "CALL_LOG": str(log),
            "CI_APT_ATTEMPTS": "2", "CI_APT_RETRY_DELAY": "0",
            "CI_PLAYWRIGHT_DEPS_ATTEMPTS": "2", "CI_PLAYWRIGHT_DEPS_RETRY_DELAY": "0", **overrides,
        }
        result = subprocess.run(["bash", str(scripts / name), "chromium" if "playwright" in name else "ffmpeg"],
                                env=env, capture_output=True, text=True)
        return result, log.read_text().splitlines() if log.exists() else []

    def test_wrapper_preflight_precedes_apt_update(self):
        result, calls = self.wrapper("ci-apt-install.sh", FAIL_ACTIVE_CHROME="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0].startswith("update "))
        self.assertTrue(calls[1].startswith("install -y --no-install-recommends ffmpeg "))

    def test_failed_updates_never_install_and_failed_installs_stay_fatal(self):
        for exit_vars, expected in [({"APT_UPDATE_EXIT": "100"}, ["update", "update"]),
                                    ({"APT_INSTALL_EXIT": "100"}, ["update", "install", "update", "install"])]:
            with self.subTest(exit_vars=exit_vars):
                result, calls = self.wrapper("ci-apt-install.sh", **exit_vars)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual([line.split()[0] for line in calls], expected)

    def test_playwright_preflight_and_retry_failures(self):
        result, calls = self.wrapper("ci-playwright-deps.sh", PLAYWRIGHT_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ["exec playwright install-deps chromium"] * 2)
        self.assertTrue(self.chrome.read_text().startswith("# Colony CI:"))

    def test_preflight_failure_stops_both_wrappers(self):
        (self.sources / "mixed.sources").write_text(f"Types: deb\nURIs: {CHROME} https://other.example/ubuntu\n")
        for name in ["ci-apt-install.sh", "ci-playwright-deps.sh"]:
            with self.subTest(name=name):
                result, calls = self.wrapper(name)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
