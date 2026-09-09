"""Hermetic apt source preparation contract; never runs sudo, apt or network IO."""

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("ci-prepare-apt-sources.py")
SPEC = importlib.util.spec_from_file_location("apt_sources", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
HOSTED = {
    "GITHUB_ACTIONS": "true",
    "RUNNER_OS": "Linux",
    "RUNNER_ENVIRONMENT": "github-hosted",
}
UBUNTU = (
    "Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\n"
    "Suites: noble noble-updates\nComponents: main universe\n"
    "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
)
CHROME = (
    "Types: deb\nURIs: https://dl.google.com/linux/chrome-stable/deb/\n"
    "Suites: stable\nComponents: main\nArchitectures: amd64\n"
    "Signed-By: /usr/share/keyrings/google-chrome.gpg\n"
)


class AptSourceContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.sources = self.root / "etc/apt/sources.list.d"
        self.sources.mkdir(parents=True)

    def put(self, name, text):
        path = self.sources / name
        path.write_bytes(text.encode("utf-8"))
        return path

    def test_list_disables_only_known_chrome_lines_and_preserves_other_bytes(self):
        other = (
            "# Ubuntu and Microsoft sources remain unchanged\r\n"
            "deb https://archive.ubuntu.com/ubuntu noble main universe\r\n"
            "deb [arch=amd64 signed-by=/keys/ms.gpg] "
            "https://packages.microsoft.com/repos/code stable main\r\n"
            "# deb https://dl.google.com/linux/chrome/deb/ stable main\r\n"
        )
        chrome_lines = [
            "deb http://dl.google.com/linux/chrome/deb/ stable main\r\n",
            "  deb [arch=amd64 signed-by=/keys/google.gpg] "
            "https://dl.google.com/linux/chrome-stable/deb stable main # managed\r\n",
        ]
        path = self.put("shared.list", other + "".join(chrome_lines))
        self.assertEqual(MODULE.prepare(self.root, HOSTED), [path])
        self.assertEqual(
            path.read_bytes(),
            (other + "".join(MODULE.COMMENT + line for line in chrome_lines)).encode(),
        )
        self.assertEqual(MODULE.prepare(self.root, HOSTED), [])

    def test_both_protocols_and_channels_in_main_sources_list(self):
        lines = [
            f"deb {scheme}://dl.google.com/linux/{channel}/deb{suffix} stable main\n"
            for scheme in ("http", "https")
            for channel in ("chrome", "chrome-stable")
            for suffix in ("", "/")
        ]
        path = self.root / "etc/apt/sources.list"
        path.write_text("".join(lines))
        self.assertEqual(MODULE.prepare(self.root, HOSTED), [path])
        self.assertTrue(all(line.startswith("# ") for line in path.read_text().splitlines()))

    def test_deb822_preserves_other_stanzas_and_disables_whole_chrome_stanza(self):
        chrome = CHROME.replace(
            "URIs: https://dl.google.com/linux/chrome-stable/deb/\n",
            "URIs: https://dl.google.com/linux/chrome-stable/deb/\n"
            " http://dl.google.com/linux/chrome/deb\n",
        )
        path = self.put("shared.sources", UBUNTU + "\n" + chrome)
        MODULE.prepare(self.root, HOSTED)
        self.assertEqual(
            path.read_bytes(),
            (
                UBUNTU + "\n"
                + "".join(MODULE.COMMENT + line for line in chrome.splitlines(True))
            ).encode(),
        )
        self.assertEqual(MODULE.prepare(self.root, HOSTED), [])

    def test_non_chrome_and_disabled_sources_remain_byte_identical(self):
        sources = {
            "ubuntu.sources": UBUNTU,
            "disabled.sources": CHROME + "Enabled: no\n",
            "other.list": (
                "deb https://dl.google.com/linux/earth/deb/ stable main\n"
                "deb https://dl.google.com.evil.example/linux/chrome/deb stable main\n"
                "deb https://dl.google.com/linux/chrome-beta/deb stable main\n"
                "deb https://example.com/linux/chrome/deb stable main\n"
            ),
        }
        for name, text in sources.items():
            self.put(name, text)
        self.assertEqual(MODULE.prepare(self.root, HOSTED), [])
        for name, text in sources.items():
            self.assertEqual((self.sources / name).read_bytes(), text.encode())

    def test_ambiguous_deb822_refuses_before_editing_an_earlier_valid_file(self):
        cases = [
            CHROME.replace("Suites: stable", "Suites: stable noble"),
            CHROME.replace("Components: main", "Components: main universe"),
            CHROME.replace("Types: deb", "Types: deb arbitrary"),
            CHROME.replace("Suites: stable", "Suites stable"),
            CHROME + "URIs: https://archive.ubuntu.com/ubuntu/\n",
            CHROME.replace(
                "deb/\nSuites:", "deb/ https://archive.ubuntu.com/ubuntu/\nSuites:"
            ),
        ]
        first = self.put(
            "a-chrome.list", "deb https://dl.google.com/linux/chrome/deb stable main\n"
        )
        original = first.read_bytes()
        for text in cases:
            with self.subTest(text=text):
                path = self.put("z-mixed.sources", text)
                with self.assertRaises(ValueError):
                    MODULE.prepare(self.root, HOSTED)
                self.assertEqual(first.read_bytes(), original)
                self.assertEqual(path.read_bytes(), text.encode())

    def test_mixed_or_malformed_list_entry_is_refused(self):
        for entry in (
            "deb https://dl.google.com/linux/chrome/deb stable main universe",
            "deb https://dl.google.com/linux/chrome/deb "
            "https://archive.ubuntu.com/ubuntu stable main",
            "not-deb https://dl.google.com/linux/chrome-stable/deb stable main",
        ):
            with self.subTest(entry=entry):
                path = self.put("mixed.list", entry + "\n")
                with self.assertRaises(ValueError):
                    MODULE.prepare(self.root, HOSTED)
                self.assertEqual(path.read_text(), entry + "\n")

    def test_non_hosted_environments_do_not_read_or_change_sources(self):
        path = self.put("malformed.sources", "URIs: " + next(iter(MODULE.CHROME_URIS)))
        original = path.read_bytes()
        for env in (
            {},
            {**HOSTED, "GITHUB_ACTIONS": "false"},
            {**HOSTED, "RUNNER_ENVIRONMENT": "self-hosted"},
            {**HOSTED, "RUNNER_OS": "macOS"},
            {key: value for key, value in HOSTED.items() if key != "RUNNER_ENVIRONMENT"},
        ):
            with self.subTest(env=env):
                self.assertEqual(MODULE.prepare(self.root, env), [])
                self.assertEqual(path.read_bytes(), original)

    def test_linked_source_is_refused_without_modifying_target(self):
        target = self.root / "unrelated-file"
        target.write_text("deb https://dl.google.com/linux/chrome/deb stable main\n")
        before = target.read_bytes()
        (self.sources / "chrome.list").symlink_to(target)
        with self.assertRaises(ValueError):
            MODULE.prepare(self.root, HOSTED)
        self.assertEqual(target.read_bytes(), before)

    def test_cli_refuses_mixed_sources_and_non_github_invocation_is_noop(self):
        path = self.put(
            "mixed.sources",
            CHROME.replace("Suites: stable", "Suites: stable noble"),
        )
        before = path.read_bytes()
        command = [sys.executable, "-B", str(SCRIPT), "--root", str(self.root)]
        refused = subprocess.run(command, env=HOSTED, capture_output=True, text=True)
        self.assertEqual(refused.returncode, 1)
        self.assertIn("Refusing ambiguous apt source preparation", refused.stderr)
        self.assertEqual(path.read_bytes(), before)
        noop = subprocess.run(command, env={}, capture_output=True, text=True)
        self.assertEqual(noop.returncode, 0)
        self.assertEqual(path.read_bytes(), before)

    def test_shell_gate_never_calls_sudo_on_local_or_self_hosted_machine(self):
        stub = self.root / "sudo"
        stub.write_text("#!/bin/sh\necho unexpected-sudo >&2\nexit 77\n")
        stub.chmod(0o755)
        shell = SCRIPT.with_suffix(".sh")
        for env in ({}, {**HOSTED, "RUNNER_ENVIRONMENT": "self-hosted"}):
            with self.subTest(env=env):
                result = subprocess.run(
                    ["/bin/bash", str(shell)],
                    env={**env, "PATH": str(self.root)},
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
