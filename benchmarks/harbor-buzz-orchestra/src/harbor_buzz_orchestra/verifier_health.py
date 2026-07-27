"""Telling a verifier that scored the agent from one that never ran.

Every Terminal-Bench verifier pip/uv-installs pytest into the task container
before it can run a single test. When that install fails, Harbor still records
reward 0 — a result shaped exactly like an agent that got the answer wrong. The
difference matters twice over: summarize.py must not report such a trial as a
score, and --resume-from must not treat it as work already done.

Both readers live in scripts/, and a marker list that drifted between them
would be worse than none: the summary would flag a trial the resume had already
skipped. Hence one definition, here.
"""

from pathlib import Path

# Both TLS phrasings appear because uv and pip word the same rejection
# differently. A Cloudflare WARP session that connected partway through an
# 89-task sweep produced 82 of the first and 6 of the second, and the run
# summarised — wrongly — as a legitimate 0%.
VERIFIER_BROKEN_MARKERS = (
    "invalid peer certificate",
    "certificate verify failed",
    "pytest: command not found",
    "no module named pytest",
)

VERIFIER_STDOUT = Path("verifier") / "test-stdout.txt"


def verifier_broken(trial_dir: Path) -> bool:
    """Whether this trial's verifier failed to install its tests.

    A missing log is not evidence: a trial that never launched has no verifier
    output at all, and that case is already reported as a launch failure.
    """
    try:
        text = (trial_dir / VERIFIER_STDOUT).read_text(
            encoding="utf-8", errors="replace"
        )
    except OSError:
        return False
    lowered = text.lower()
    return any(marker in lowered for marker in VERIFIER_BROKEN_MARKERS)
