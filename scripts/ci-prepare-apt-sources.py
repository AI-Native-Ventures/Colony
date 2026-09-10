"""Exclude only unused Chrome sources on disposable GitHub Linux runners.

No apt command or trust setting is changed. Plan every file before writing so
an ambiguous mixed source fails the job without partially editing its sources.
"""

import argparse
import os
from pathlib import Path
import re
import stat
import sys


CHROME_URIS = {
    f"{scheme}://dl.google.com/linux/{channel}/deb{suffix}"
    for scheme in ("http", "https")
    for channel in ("chrome", "chrome-stable")
    for suffix in ("", "/")
}
COMMENT = "# Disabled unused Google Chrome source for Colony CI: "


def hosted_linux(env):
    """Default runner variables; a local or self-hosted invocation is a no-op."""
    return (
        env.get("GITHUB_ACTIONS") == "true"
        and env.get("RUNNER_OS") == "Linux"
        and env.get("RUNNER_ENVIRONMENT") == "github-hosted"
    )


def contains_chrome(text):
    return any(token in CHROME_URIS for token in text.split())


def list_source(text):
    """One-line sources are independent; preserve every other line verbatim."""
    result = []
    for line in text.splitlines(keepends=True):
        active = line.split("#", 1)[0].strip()
        if not contains_chrome(active):
            result.append(line)
            continue
        match = re.fullmatch(
            r"(deb|deb-src)\s+(?:\[[^\]\r\n]*\]\s+)?(\S+)\s+(\S+)\s+(.+)",
            active,
        )
        if (
            not match
            or match[2] not in CHROME_URIS
            or match[3] != "stable"
            or match[4].split() != ["main"]
        ):
            raise ValueError("ambiguous Chrome .list entry")
        result.append(COMMENT + line)
    return "".join(result)


def sources_stanza(lines):
    """Disable a whole deb822 Chrome stanza, never remove one URI from a mix."""
    active = [line for line in lines if not line.lstrip().startswith("#")]
    if not contains_chrome(" ".join(active)):
        return "".join(lines)
    fields = {}
    previous = None
    for line in active:
        if line[:1].isspace() and previous:
            fields[previous] += " " + line.strip()
            continue
        match = re.fullmatch(
            r"([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)", line.rstrip("\r\n")
        )
        if not match or match[1].lower() in fields:
            raise ValueError("malformed or duplicate Chrome deb822 field")
        previous = match[1].lower()
        fields[previous] = match[2]
    if fields.get("enabled", "yes").lower() == "no":
        return "".join(lines)
    uris = fields.get("uris", "").split()
    if (
        not uris
        or not all(uri in CHROME_URIS for uri in uris)
        or not fields.get("types", "").split()
        or not all(kind in ("deb", "deb-src") for kind in fields["types"].split())
        or fields.get("suites", "").split() != ["stable"]
        or fields.get("components", "").split() != ["main"]
        or fields.get("enabled", "yes").lower() != "yes"
    ):
        raise ValueError("ambiguous mixed Chrome deb822 source")
    return "".join(COMMENT + line for line in lines)


def deb822_source(text):
    result = []
    stanza = []
    for line in text.splitlines(keepends=True):
        if line.strip():
            stanza.append(line)
        else:
            result.append(sources_stanza(stanza))
            stanza = []
            result.append(line)
    result.append(sources_stanza(stanza))
    return "".join(result)


def prepare(root, env):
    """Transform only regular apt source files beneath the captured root."""
    if not hosted_linux(env):
        return []
    root = Path(root)
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError("apt root must be absolute and must not be linked")
    directory = root / "etc/apt"
    for folder in (root / "etc", directory, directory / "sources.list.d"):
        if folder.is_symlink():
            raise ValueError("linked apt source directory")
    paths = [directory / "sources.list"]
    paths += sorted((directory / "sources.list.d").glob("*.list"))
    paths += sorted((directory / "sources.list.d").glob("*.sources"))
    changes = []
    for path in paths:
        if not path.exists() and not path.is_symlink():
            continue
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError(f"apt source is not a regular file: {path.name}")
        before = path.read_bytes()
        text = before.decode("utf-8")
        transformed = (
            deb822_source(text) if path.suffix == ".sources" else list_source(text)
        )
        after = transformed.encode("utf-8")
        if after != before:
            changes.append((path, before, after))
    # A malformed or mixed entry anywhere above prevents every write.
    for path, before, after in changes:
        if not stat.S_ISREG(path.lstat().st_mode) or path.read_bytes() != before:
            raise ValueError("apt source changed during preparation")
        path.write_bytes(after)
    return [path for path, _, _ in changes]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/"))
    args = parser.parse_args()
    try:
        for path in prepare(args.root, os.environ):
            print(f"::notice::Excluded unused Google Chrome apt source in {path}")
    except (OSError, ValueError) as error:
        print(
            f"::error::Refusing ambiguous apt source preparation: {error}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
