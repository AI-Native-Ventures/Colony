"""Per-agent token and cost accounting for a trial.

Harbor records whatever ``AgentContext`` is given, and until this module existed
it was given the ``RuntimeResult`` defaults: zero tokens, ``$0.00``, on every
trial. A sweep could complete "successfully" and carry no cost signal at all,
which is worse than an error because nothing announces it.

**Where the numbers come from.** ``buzz-agent`` emits a
``_goose/unstable/session/update`` notification with session-cumulative token
counts at the end of every turn. ``buzz-acp`` records it and logs it under the
``acp::usage`` tracing target, so enabling that target (see
``container_runtime.DEFAULT_RUST_LOG``) puts the counters in each agent's
captured process log, which the runtime already downloads. We parse them there.

**Cached input is not separable, so the discount is modelled.**
``LlmResponse.input_tokens`` in ``buzz-agent`` is an inclusive sum
(``input + cache_read + cache_creation``) and nothing downstream carries the
split. Rather than pricing every input token at the full rate — which
over-reports, and unevenly, since OpenAI-route endpoints cache automatically
while Anthropic-route ones currently do not cache at all — each endpoint
declares a ``cache_read_rate`` in its manifest ``Price``. That fraction of input
is billed at the cached rate. Because the assumption lives in the manifest it is
frozen into the condition hash, and every receipt carries both the estimate and
``cost_usd_no_cache_discount``, so the assumption's leverage is always visible.
Getting *measured* cache reads means threading the cache fields through
``LlmResponse`` and the usage notification.

**Reasoning tokens are not separable, and this does not affect cost.**
Providers bill thinking at the output rate, so reasoning tokens inside
``output_tokens`` are already priced correctly. What is unavailable is the
thinking-vs-answer *split* — an analysis detail, not a cost error.

**Auto-compaction ("handoff") calls are billed but unmetered upstream.** When a
session crosses its compaction threshold (see ``GenerationConfig``)
``buzz-agent`` summarises the history into a fresh context
(``crates/buzz-agent/src/handoff.rs``). That summarisation
is a real provider call, but ``Llm::summarize`` returns ``Result<String, _>`` and
throws its ``LlmResponse`` usage away, so those tokens never reach the turn
counters and never reach the ``usage_update`` notification we parse. On a long
trial with the default ``max_handoffs`` of 80 the omission is easily larger than
everything else we model. We cannot recover the true figure without a change to
``buzz-agent``, so instead we parse the handoff log lines — which do carry the
pre-handoff context size — and publish a *bound*: each handoff is charged at
most its pre-handoff context as input plus ``HANDOFF_MAX_OUTPUT_TOKENS`` (32000)
as output. Receipts carry the metered cost and the bound separately, never
merged, and any trial that handed off is flagged in the reconciliation note.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

from .manifest import AgentClass, ExperimentManifest, Price


# `tracing_subscriber`'s formatter colours output unconditionally — it does not
# check for a tty, so a log redirected to a file is coloured exactly like a
# terminal. The escapes land *inside* each field, between the name and the `=`:
#
#   goose usage update \x1b[3minput\x1b[0m\x1b[2m=\x1b[0m20658
#
# so a pattern like `\binput=(\d+)` never matches, and the trial silently prices
# at zero — the worst failure mode available, because the run still succeeds and
# still costs money. Strip the escapes before matching rather than relying on
# NO_COLOR or a build flag: this holds for logs already on disk, and for any
# future agent binary regardless of how its subscriber is configured.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")

# With colour stripped, tracing's compact formatter renders the buzz-acp call
# site as, e.g.:
#   2026-07-26T01:02:03.456789Z DEBUG acp::usage: goose usage update \
#       session_id=01J... input=12345 output=678
# Match the fields independently so a formatter change (field order, added
# fields) degrades to "no samples" rather than a wrong number.
USAGE_MARKER = "goose usage update"
_SESSION_RE = re.compile(r"\bsession_id=(\S+)")
_INPUT_RE = re.compile(r"\binput=(\d+)\b")
_OUTPUT_RE = re.compile(r"\boutput=(\d+)\b")

# buzz-agent logs one line per completed auto-compaction, at INFO on its own
# stderr (which buzz-acp inherits, so it lands in the captured log):
#   2026-07-26T..Z  INFO buzz_agent::handoff: handoff #1 \
#       (history 84 -> 3 items; 181430 -> 5120 tokens)
# The first token figure is the pre-handoff context, i.e. the ceiling on what
# the summarisation call could have sent as input.
_HANDOFF_RE = re.compile(r"\bhandoff #(\d+) \(history .*?; (\d+) -> \d+ tokens\)")
# Emitted when the handoff cap is hit, or the summary comes back empty/errored.
# In each case the agent silently falls back to truncating its own history —
# a task-fidelity event worth surfacing next to the cost, not just a log line.
_TRUNCATION_MARKER = "truncat"
_HANDOFF_MARKER = "handoff"
# crates/buzz-agent/src/config.rs: HANDOFF_MAX_OUTPUT_TOKENS. The agent clamps
# this to half the context window, so on a small window the real allowance is
# lower than this — which keeps the figure below an upper bound, never under it.
HANDOFF_MAX_OUTPUT_TOKENS = 32_000


@dataclass(frozen=True, slots=True)
class HandoffUsage:
    """Auto-compaction activity observed for one agent, as bounds not measurements.

    ``input_tokens_upper_bound`` sums each handoff's logged pre-handoff context.
    The summarisation prompt is built from that same history under a byte budget
    derived from the context window, so it cannot meaningfully exceed it; the
    only slack is the prompt header, which is capped at 16 KiB of original task
    text plus at most 20 tool names.
    """

    count: int = 0
    input_tokens_upper_bound: int = 0
    output_tokens_upper_bound: int = 0
    truncations: int = 0


def parse_handoffs(text: str) -> HandoffUsage:
    """Count auto-compactions and bound the tokens they burned."""
    contexts: list[int] = []
    truncations = 0
    for line in _ANSI_RE.sub("", text).splitlines():
        match = _HANDOFF_RE.search(line)
        if match is not None:
            contexts.append(int(match.group(2)))
            continue
        lowered = line.lower()
        if _HANDOFF_MARKER in lowered and _TRUNCATION_MARKER in lowered:
            truncations += 1
    return HandoffUsage(
        count=len(contexts),
        input_tokens_upper_bound=sum(contexts),
        output_tokens_upper_bound=len(contexts) * HANDOFF_MAX_OUTPUT_TOKENS,
        truncations=truncations,
    )


@dataclass(frozen=True, slots=True)
class SessionUsage:
    """Final cumulative counters observed for one agent session."""

    session_id: str
    input_tokens: int
    output_tokens: int


def parse_usage_log(text: str) -> tuple[SessionUsage, ...]:
    """Extract final per-session token counters from captured agent logs.

    The counters are session-cumulative and emitted once per turn, so the
    largest value seen for a session is that session's final total. Taking the
    max rather than the last line also survives interleaved or truncated
    output, which a container log tail can easily produce.
    """
    high_water: dict[str, tuple[int, int]] = {}
    for line in _ANSI_RE.sub("", text).splitlines():
        if USAGE_MARKER not in line:
            continue
        input_match = _INPUT_RE.search(line)
        output_match = _OUTPUT_RE.search(line)
        if input_match is None or output_match is None:
            continue
        session_match = _SESSION_RE.search(line)
        session_id = session_match.group(1) if session_match else "unknown"
        seen_in, seen_out = high_water.get(session_id, (0, 0))
        high_water[session_id] = (
            max(seen_in, int(input_match.group(1))),
            max(seen_out, int(output_match.group(1))),
        )
    return tuple(
        SessionUsage(
            session_id=session_id, input_tokens=tokens[0], output_tokens=tokens[1]
        )
        for session_id, tokens in sorted(high_water.items())
    )


@dataclass(frozen=True, slots=True)
class AgentReceipt:
    """One agent's measured usage and its priced cost for a trial."""

    agent_id: str
    class_id: str
    role: str
    endpoint: str
    model_revision: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    sessions: int
    source: str
    # The cache assumption behind cost_usd, and the same usage without it.
    cost_usd_no_cache_discount: float = 0.0
    estimated_cache_read_tokens: int = 0
    cache_read_rate: float = 0.0
    cache_read_tokens_are_estimated: bool = True
    # Reasoning is billed at the output rate, so cost_usd is right; only the
    # thinking-vs-answer split is unavailable.
    reasoning_tokens_included_in_output: bool = True
    # Auto-compaction calls buzz-agent bills but never reports. Kept strictly
    # apart from the metered figures above: input_tokens/output_tokens/cost_usd
    # remain "what the provider told us", and these remain "what it did not".
    handoffs: int = 0
    handoff_truncations: int = 0
    handoff_input_tokens_upper_bound: int = 0
    handoff_output_tokens_upper_bound: int = 0
    handoff_cost_usd_upper_bound: float = 0.0

    @property
    def cost_usd_including_handoff_bound(self) -> float:
        """Metered cost plus the worst case for the calls nobody metered."""
        return self.cost_usd + self.handoff_cost_usd_upper_bound

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        data["cost_usd_including_handoff_bound"] = self.cost_usd_including_handoff_bound
        return data


@dataclass(frozen=True, slots=True)
class TrialAccounting:
    """Aggregate trial usage, with an explicit reconciliation verdict."""

    receipts: tuple[AgentReceipt, ...] = ()
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    cost_usd_no_cache_discount: float = 0.0
    estimated_cache_read_tokens: int = 0
    handoffs: int = 0
    handoff_truncations: int = 0
    handoff_cost_usd_upper_bound: float = 0.0
    reconciled: bool = False
    reconciliation_note: str = ""
    warnings: tuple[str, ...] = field(default=())

    @property
    def assumes_cache_discount(self) -> bool:
        """True when any endpoint priced part of its input at the cached rate."""
        return self.estimated_cache_read_tokens > 0

    @property
    def cost_usd_including_handoff_bound(self) -> float:
        """Upper bound on trial cost with unmetered auto-compaction included."""
        return self.cost_usd + self.handoff_cost_usd_upper_bound

    def to_metadata(self) -> dict[str, Any]:
        """The accounting summary Harbor stores alongside the trial result."""
        return {
            "accounting_source": "acp-usage-log",
            "accounting_reconciled": self.reconciled,
            "accounting_note": self.reconciliation_note,
            "accounting_warnings": list(self.warnings),
            # Cost is an estimate in one direction or the other: with a cache
            # rate set it can under-report, without one it over-reports. Both
            # figures travel so a reader never has to guess which.
            "accounting_cost_usd_no_cache_discount": self.cost_usd_no_cache_discount,
            "accounting_estimated_cache_read_tokens": self.estimated_cache_read_tokens,
            "accounting_assumes_cache_discount": self.assumes_cache_discount,
            # Auto-compaction: billed by the provider, never reported by the
            # agent. Travels as a separate bound so no reader mistakes the
            # metered cost for the whole cost on a long trial.
            "accounting_handoffs": self.handoffs,
            "accounting_handoff_truncations": self.handoff_truncations,
            "accounting_handoff_cost_usd_upper_bound": (
                self.handoff_cost_usd_upper_bound
            ),
            "accounting_cost_usd_including_handoff_bound": (
                self.cost_usd_including_handoff_bound
            ),
            "per_agent_tokens": {
                receipt.agent_id: {
                    "input": receipt.input_tokens,
                    "output": receipt.output_tokens,
                    "cost_usd": receipt.cost_usd,
                    "cost_usd_no_cache_discount": receipt.cost_usd_no_cache_discount,
                    "cache_read_rate": receipt.cache_read_rate,
                    "handoffs": receipt.handoffs,
                    "handoff_cost_usd_upper_bound": (
                        receipt.handoff_cost_usd_upper_bound
                    ),
                }
                for receipt in self.receipts
            },
        }

    def write_receipts(self, path: Path) -> None:
        """Write one JSON object per agent, newline-delimited."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            for receipt in self.receipts:
                handle.write(json.dumps(receipt.to_json(), sort_keys=True) + "\n")
        path.chmod(0o600)


@dataclass(frozen=True, slots=True)
class PricedUsage:
    """A cost estimate together with the assumption that produced it."""

    cost_usd: float
    # Same usage priced with no cache discount at all. Reporting both makes the
    # assumption's leverage visible instead of burying it in one number.
    cost_usd_no_cache_discount: float
    estimated_cache_read_tokens: int
    cache_read_rate: float


def price_usage(price: Price, input_tokens: int, output_tokens: int) -> PricedUsage:
    """Cost in USD, splitting input by the endpoint's assumed cache-read rate.

    The upstream counts are an inclusive input total with no cache split, so the
    discount is *modelled*: ``cache_read_rate`` of the input is billed at
    ``cached_input_per_million_usd`` and the remainder at the full rate. At the
    default rate of 0.0 this is exactly the no-discount upper bound.

    Reasoning tokens need no special handling — providers bill them at the
    output rate, so they are already priced correctly inside ``output_tokens``.
    """
    cache_read = round(input_tokens * price.cache_read_rate)
    uncached = input_tokens - cache_read
    output_cost = output_tokens * price.output_per_million_usd
    return PricedUsage(
        cost_usd=(
            uncached * price.input_per_million_usd
            + cache_read * price.cached_input_per_million_usd
            + output_cost
        )
        / 1_000_000,
        cost_usd_no_cache_discount=(
            input_tokens * price.input_per_million_usd + output_cost
        )
        / 1_000_000,
        estimated_cache_read_tokens=cache_read,
        cache_read_rate=price.cache_read_rate,
    )


def _read_agent_logs(trial_dir: Path, agent_id: str) -> str:
    """Concatenate every captured log for one agent.

    ``tracing_subscriber::fmt()`` writes to stdout by default, but the agent
    stack is launched with stdout and stderr on separate files and either could
    carry the usage lines depending on how the subscriber is configured. Reading
    both costs nothing and removes a silent failure mode.
    """
    chunks: list[str] = []
    for pattern in (f"**/{agent_id}.stdout.log", f"**/{agent_id}.stderr.log"):
        for path in sorted(trial_dir.glob(pattern)):
            try:
                chunks.append(path.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
    return "\n".join(chunks)


def collect(
    *,
    trial_dir: Path,
    manifest: ExperimentManifest,
    agents: Iterable[tuple[str, str, AgentClass]],
) -> TrialAccounting:
    """Build the trial's accounting from downloaded agent logs.

    ``agents`` yields ``(agent_id, role, agent_class)`` for every provisioned
    agent — including ones that produced no usage, so a silent agent shows up as
    an explicit zero row instead of being absent.
    """
    receipts: list[AgentReceipt] = []
    warnings: list[str] = []
    silent: list[str] = []

    for agent_id, role, agent_class in agents:
        log_text = _read_agent_logs(trial_dir, agent_id)
        sessions = parse_usage_log(log_text)
        handoff = parse_handoffs(log_text)
        input_tokens = sum(session.input_tokens for session in sessions)
        output_tokens = sum(session.output_tokens for session in sessions)
        if not sessions:
            silent.append(agent_id)
        price = manifest.prices.get(agent_class.endpoint)
        if price is None:
            # validate_roster guarantees this cannot happen; treat a future
            # regression as a priced-zero row plus a loud warning, never a crash
            # that discards an otherwise complete trial.
            warnings.append(f"no price for endpoint {agent_class.endpoint!r}")
            priced = PricedUsage(0.0, 0.0, 0, 0.0)
            handoff_cost = 0.0
        else:
            priced = price_usage(price, input_tokens, output_tokens)
            # Priced with no cache discount: a summarisation prompt is a
            # freshly assembled digest, so assuming it hits a warm cache would
            # be the wrong direction for something already labelled a bound.
            handoff_cost = price_usage(
                price,
                handoff.input_tokens_upper_bound,
                handoff.output_tokens_upper_bound,
            ).cost_usd_no_cache_discount
        if handoff.truncations:
            warnings.append(
                f"{agent_id} truncated its own history {handoff.truncations}x "
                "(handoff cap reached or summarisation failed) — context was "
                "dropped, which affects task fidelity, not just cost"
            )
        receipts.append(
            AgentReceipt(
                agent_id=agent_id,
                class_id=agent_class.id,
                role=role,
                endpoint=agent_class.endpoint,
                model_revision=agent_class.model_revision,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=priced.cost_usd,
                sessions=len(sessions),
                source="acp-usage-log",
                cost_usd_no_cache_discount=priced.cost_usd_no_cache_discount,
                estimated_cache_read_tokens=priced.estimated_cache_read_tokens,
                cache_read_rate=priced.cache_read_rate,
                handoffs=handoff.count,
                handoff_truncations=handoff.truncations,
                handoff_input_tokens_upper_bound=handoff.input_tokens_upper_bound,
                handoff_output_tokens_upper_bound=handoff.output_tokens_upper_bound,
                handoff_cost_usd_upper_bound=handoff_cost,
            )
        )

    total_input = sum(receipt.input_tokens for receipt in receipts)
    total_output = sum(receipt.output_tokens for receipt in receipts)
    total_handoffs = sum(receipt.handoffs for receipt in receipts)
    total_handoff_cost = sum(
        receipt.handoff_cost_usd_upper_bound for receipt in receipts
    )

    # The reconciliation gate. A trial that ran agents but observed no tokens is
    # an instrumentation failure, not a free trial, and must never be averaged
    # into a cost figure as if it were a real zero.
    if not receipts:
        reconciled, note = False, "no agents were provisioned"
    elif total_input == 0 and total_output == 0:
        reconciled, note = (
            False,
            (
                "agents ran but reported no tokens — check that RUST_LOG enables the "
                "acp::usage target and that the agent logs were downloaded"
            ),
        )
    elif silent:
        reconciled, note = (
            False,
            (f"no usage observed for {sorted(silent)}; totals undercount this trial"),
        )
    else:
        reconciled, note = True, "every agent reported usage"

    # Handoffs do not fail reconciliation — the metered figures are still exactly
    # what the provider reported. They do make the metered total a floor rather
    # than the answer, and the note is the only place a reader reliably looks.
    if total_handoffs:
        note = (
            f"{note}; {total_handoffs} auto-compaction call(s) are billed but "
            "unreported by buzz-agent, so cost_usd is a floor — see "
            f"cost_usd_including_handoff_bound (+${total_handoff_cost:.4f} max)"
        )

    return TrialAccounting(
        receipts=tuple(receipts),
        input_tokens=total_input,
        output_tokens=total_output,
        cost_usd=sum(receipt.cost_usd for receipt in receipts),
        cost_usd_no_cache_discount=sum(
            receipt.cost_usd_no_cache_discount for receipt in receipts
        ),
        estimated_cache_read_tokens=sum(
            receipt.estimated_cache_read_tokens for receipt in receipts
        ),
        handoffs=total_handoffs,
        handoff_truncations=sum(receipt.handoff_truncations for receipt in receipts),
        handoff_cost_usd_upper_bound=total_handoff_cost,
        reconciled=reconciled,
        reconciliation_note=note,
        warnings=tuple(warnings),
    )
