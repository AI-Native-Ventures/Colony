#!/usr/bin/env python3
"""Disable only unrelated Chrome APT entries on ephemeral GitHub Ubuntu runners.

APT_ROOT is a fixture root, matching ci-drop-azure-mirror.sh. Real source writes
are elevated only after validating the runner and finding a matching entry.
Package authentication, Ubuntu/security sources and APT exit statuses are untouched.
"""

import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


def is_chrome_uri(value):
    """Match the two official Chrome repo paths, never substrings or lookalikes."""
    try:
        uri = urlsplit(value)
        return (
            uri.scheme in {"http", "https"}
            and uri.hostname == "dl.google.com"
            and uri.port is None
            and uri.username is None
            and uri.password is None
            and uri.path.rstrip("/") in {"/linux/chrome/deb", "/linux/chrome-stable/deb"}
            and not uri.query
            and not uri.fragment
        )
    except ValueError:
        return False


def disable_list(text):
    """Preserve every byte except the comment prefix on exact Chrome entries."""
    result = []
    for line in text.splitlines(keepends=True):
        match = re.match(r"^\s*deb(?:-src)?\s+(?:\[[^\]\n]*\]\s+)?(\S+)", line)
        if match and is_chrome_uri(match[1]):
            line = "# Colony CI: unrelated Chrome source disabled: " + line
        result.append(line)
    return "".join(result)


def disable_stanza(stanza):
    """Disable Chrome-only deb822 stanzas; mixed repositories fail closed."""
    fields = {}
    active = None
    lines = stanza.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.lstrip().startswith("#"):
            continue
        if line.startswith((" ", "\t")) and active:
            fields[active][-1][1] += " " + line.strip()
            continue
        match = re.match(r"^([A-Za-z][A-Za-z0-9-]*):\s*(.*)", line)
        active = match[1].lower() if match else None
        if active:
            fields.setdefault(active, []).append([index, match[2].strip()])
    uris = [uri for _, value in fields.get("uris", []) for uri in value.split()]
    if not any(is_chrome_uri(uri) for uri in uris):
        return stanza
    if len(fields.get("uris", [])) != 1 or not all(is_chrome_uri(uri) for uri in uris):
        raise ValueError("refusing to disable a mixed Chrome/non-Chrome APT stanza")
    enabled = fields.get("enabled", [])
    if len(enabled) > 1 or (enabled and enabled[0][1].lower() not in {"yes", "no"}):
        raise ValueError("ambiguous Enabled field in Chrome APT stanza")
    if enabled and enabled[0][1].lower() == "no":
        return stanza
    newline = "\r\n" if "\r\n" in stanza else "\n"
    if enabled:
        index = enabled[0][0]
        ending = newline if lines[index].endswith("\n") else ""
        lines[index] = "Enabled: no" + ending
        return "".join(lines)
    return "Enabled: no" + newline + stanza


def disable_sources(text):
    """Preserve stanza separators and all non-Chrome stanzas verbatim."""
    parts = re.split(r"(\r?\n(?:[ \t]*\r?\n)+)", text)
    return "".join(part if index % 2 else disable_stanza(part) for index, part in enumerate(parts))


def write_source(path, text):
    """Replace a regular source atomically, retaining its existing permissions."""
    if path.is_symlink():
        raise ValueError(f"refusing to rewrite a symlinked APT source: {path}")
    mode = path.stat().st_mode & 0o777
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=path.parent,
                                         prefix=".colony-apt-", delete=False) as output:
            temporary = Path(output.name)
            output.write(text)
            os.fchmod(output.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run():
    """Prepare all edits before writing; failure prevents the dependency install."""
    if not (
        os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and os.environ.get("RUNNER_OS") == "Linux"
    ):
        return 0
    root = Path(os.environ.get("APT_ROOT") or "/").resolve()
    release = root / "etc/os-release"
    if not release.exists() or not re.search(r'^ID=["\']?ubuntu["\']?$', release.read_text(), re.MULTILINE):
        return 0
    directory = root / "etc/apt/sources.list.d"
    paths = [root / "etc/apt/sources.list", *sorted(directory.glob("*.list")), *sorted(directory.glob("*.sources"))]
    changes = []
    for path in paths:
        if not path.is_file():
            continue
        with path.open(encoding="utf-8", newline="") as source:
            original = source.read()
        updated = disable_sources(original) if path.suffix == ".sources" else disable_list(original)
        if updated != original:
            changes.append((path, updated))
    if not changes:
        return 0
    if root == Path("/") and os.geteuid() != 0:
        # sudo normally strips these variables; forward only the verified guard.
        return subprocess.call([
            "sudo", "env", "GITHUB_ACTIONS=true", "RUNNER_ENVIRONMENT=github-hosted",
            "RUNNER_OS=Linux", sys.executable, str(Path(__file__).resolve()),
        ])
    for path, updated in changes:
        write_source(path, updated)
        print(f"::notice::disabled unrelated Google Chrome APT source in {path}", flush=True)
    return 0


def main():
    try:
        return run()
    except (OSError, ValueError) as error:
        print(f"::error::Chrome source preflight failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
