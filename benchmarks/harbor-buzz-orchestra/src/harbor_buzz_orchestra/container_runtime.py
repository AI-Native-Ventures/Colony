"""Run the production Buzz agent stack inside the Harbor task container.

Each provisioned identity is a full ``buzz-acp`` → ``buzz-agent`` →
``buzz-dev-mcp`` process tree launched *inside* the task container — the same
binaries and the same MCP toolset (shell, file tools, the ``buzz`` CLI on
PATH) that the desktop app gives a Buzz agent. The harness stays outside:
it provisions, uploads the pinned binaries, posts the task as the trial
user, and observes the channel until the orchestrator publishes DONE.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import certifi
from harbor.environments.base import BaseEnvironment

from . import accounting, bundle
from .accounting import USAGE_MARKER
from .manifest import AgentClass, ExperimentManifest, GenerationConfig
from .provisioning import AgentCredential, TrialHandle
from .runtime import RuntimeResult


# Tool/LLM rounds allowed per agent turn (BUZZ_AGENT_MAX_ROUNDS).
#
# Deliberately set high enough that no condition reaches it, because the cap is
# per *turn* and the counter resets on every wake (buzz-agent agent.rs:82). A
# solo agent is woken exactly once, so its cap is its whole budget for the task;
# a team member gets the same cap per assignment, across arbitrarily many
# assignments. Any value a real task can hit therefore handicaps the solo
# baseline for a reason unrelated to team shape. Let the trial timeout and the
# cost ceiling bind instead — those apply to every condition equally.
DEFAULT_MAX_AGENT_ROUNDS = 300
# buzz-acp logs each agent's cumulative token counters under this tracing
# target. It is the harness's only token source, so the directive is not
# optional decoration — without it every trial reports zero cost. See
# accounting.py.
USAGE_LOG_TARGET = "acp::usage"
# buzz-acp logs the end of every turn under this target — "turn complete for
# channel <id>: end_turn" for a clean finish, warnings for max_tokens,
# max_turn_requests, refusal, cancellation (pool.rs:3058). The harness reads it
# to tell a working agent from a finished one; see _turn_ended.
TURN_LOG_TARGET = "pool::prompt"
# What the agent said and which tools it called. Neither is load-bearing, and
# both were off for the first full sweep — which is why 13 trials that ended
# their turn in under four minutes could not be distinguished from 13 trials
# still grinding, and were written off as slow. Cheap to keep on: one line per
# message and per tool call, in a log the bundle already scans for secrets.
STREAM_LOG_TARGET = "acp::stream"
TOOL_LOG_TARGET = "acp::tool"
DEFAULT_RUST_LOG = ",".join(
    (
        "buzz_acp=info",
        f"{USAGE_LOG_TARGET}=debug",
        f"{TURN_LOG_TARGET}=info",
        f"{STREAM_LOG_TARGET}=info",
        f"{TOOL_LOG_TARGET}=info",
    )
)
# Marker for a turn that ended for any reason. Every log_stop_reason branch
# starts with this, so it matches the clean end_turn and the four failure
# reasons alike — an agent that stopped because it hit max_tokens is just as
# finished as one that stopped because it was done.
TURN_ENDED_MARKERS = (
    "turn complete for",
    "turn cancelled for",
    "turn hit max_tokens for",
    "turn hit max_turn_requests for",
    "turn refused for",
)
# Reasoning effort, held constant across every agent in every condition.
#
# Deliberately a constant rather than a manifest field: per-entry effort is a
# real experiment (G2) and needs its own axis in the matrix, but until that
# axis exists, an unset effort means "whatever the provider defaults to" —
# which is neither recorded nor stable across endpoints. Pinning it here makes
# the study's one uniform-effort claim true, and buzz-agent logs a clamp
# warning if a model cannot honour it (config.rs:223).
THINKING_EFFORT = "medium"
# Container-side layout for the uploaded Buzz stack.
REMOTE_ROOT = "/opt/buzz"
REMOTE_BIN = f"{REMOTE_ROOT}/bin"
REMOTE_PROMPTS = f"{REMOTE_ROOT}/prompts"
REMOTE_LOGS = f"{REMOTE_ROOT}/logs"
# The relay is host-header tenant-bound (its community row is the authority
# of its own RELAY_URL), so agents must present that exact Host. When the
# relay actually lives outside the container, this forwarder listens on the
# canonical loopback address and bridges the byte stream to the gateway.
FORWARDER = f"{REMOTE_BIN}/relay-forwarder"
FORWARDER_LOG = f"{REMOTE_LOGS}/relay-forwarder.log"
# Trust anchors the agent uses to reach its model provider over TLS.
#
# buzz-agent links reqwest's `rustls` feature, which loads roots via
# rustls-native-certs — it reads the *container's* trust store, and a task
# image that never installed `ca-certificates` has none. `Client::builder()
# .build()` then fails outright ("http: builder error"), buzz-agent exits
# before it ever reaches the relay, and the trial dies in launch with a
# RuntimeLaunchError. That failure is a property of the task image rather than
# of the agent, so leaving it in place would score a fixed subset of
# Terminal-Bench tasks zero for every condition and understate every model's
# ability by the same silent margin.
#
# Shipping our own bundle and pointing SSL_CERT_FILE at it (rustls-native-certs
# 0.8 honours it, lib.rs:361) fixes this without touching the task image, and
# without needing the network or a package manager inside the container.
REMOTE_CA_BUNDLE = f"{REMOTE_ROOT}/ca-certificates.crt"
# How many done-poll iterations between in-container liveness probes.
LIVENESS_EVERY = 10
# Messages pulled into the saved transcript. Well above what a trial can
# produce — a 900s budget at roughly one message per agent turn does not reach
# three figures — so hitting it means something pathological happened, which is
# itself worth seeing. Recorded as ``truncated`` when reached.
TRANSCRIPT_LIMIT = 1000


class RuntimeLaunchError(RuntimeError):
    """Raised when a Buzz agent process cannot be launched or exits early."""


@dataclass(frozen=True, slots=True)
class EndpointLaunchConfig:
    """Deployment-specific environment needed to launch one manifest endpoint."""

    provider: str
    api_key_env: str
    env: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class _Agent:
    credential: AgentCredential
    pid: int
    stdout_log: str  # container path
    stderr_log: str  # container path


class BuzzContainerRuntime:
    """Launch one production Buzz agent stack per identity in the container."""

    def __init__(
        self,
        *,
        logs_dir: Path,
        artifact_root: Path,
        endpoints: dict[str, EndpointLaunchConfig],
        buzz_acp_binary: str = "buzz-acp",
        buzz_agent_binary: str = "buzz-agent",
        buzz_dev_mcp_binary: str = "buzz-dev-mcp",
        buzz_cli_binary: str = "buzz",
        relay_gateway: str = "",
        forwarder_binary: str = "relay-forwarder",
        ca_bundle: str | None = None,
        max_agent_rounds: int = DEFAULT_MAX_AGENT_ROUNDS,
        readiness_timeout_seconds: float = 60.0,
        # Grace for the post-DONE usage notification; see _settle_usage.
        # Generous on purpose: `DONE:` is published from inside a tool call, so
        # the notification can be a whole model round-trip behind it, and a
        # thinking model's round-trip is tens of seconds. Costs nothing when the
        # line is already there, which is the common case.
        usage_settle_seconds: float = 60.0,
        poll_seconds: float = 1.0,
    ) -> None:
        if max_agent_rounds <= 0:
            raise ValueError("max_agent_rounds must be positive")
        if readiness_timeout_seconds <= 0:
            raise ValueError("readiness_timeout_seconds must be positive")
        if usage_settle_seconds < 0:
            raise ValueError("usage_settle_seconds must not be negative")
        self.logs_dir = Path(logs_dir)
        self.artifact_root = Path(artifact_root)
        self.endpoints = endpoints
        # Linux builds uploaded into the task container:
        self.buzz_acp_binary = buzz_acp_binary
        self.buzz_agent_binary = buzz_agent_binary
        self.buzz_dev_mcp_binary = buzz_dev_mcp_binary
        # Host build used for user/provisioning operations only:
        self.buzz_cli_binary = buzz_cli_binary
        # Where the relay actually lives, as seen from inside the task
        # container (e.g. host.docker.internal:3600). When set, a loopback
        # forwarder bridges the agents' canonical relay address — the Host
        # the relay's community row is bound to — to this gateway.
        self.relay_gateway = relay_gateway
        self.forwarder_binary = forwarder_binary
        # Uploaded into every task container regardless of what the image
        # already trusts: see REMOTE_CA_BUNDLE. certifi is the Mozilla bundle
        # already pinned in this project's lockfile, so the trust anchors are
        # versioned with the harness instead of varying per task image.
        self.ca_bundle = ca_bundle or certifi.where()
        self.max_agent_rounds = max_agent_rounds
        self.readiness_timeout_seconds = readiness_timeout_seconds
        self.usage_settle_seconds = usage_settle_seconds
        self.poll_seconds = poll_seconds

    async def run(
        self,
        *,
        instruction: str,
        environment: BaseEnvironment,
        manifest: ExperimentManifest,
        trial: TrialHandle,
    ) -> RuntimeResult:
        classes = self._classes_by_agent_id(manifest, trial.credentials)
        orchestrator = next(c for c in trial.credentials if c.role == "orchestrator")
        # A zero-worker roster is the single-agent baseline, not an error. The
        # lone agent gets byte-identical wiring to a worker (same binaries, same
        # MCP toolset, same env) — anything less would handicap the baseline
        # every multi-agent condition is compared against.
        trial_dir = self.logs_dir / "buzz"
        trial_dir.mkdir(parents=True, exist_ok=True)

        agents: list[_Agent] = []
        infra: list[_Agent] = []
        try:
            await self._install_stack(environment)
            forwarder = await self._start_forwarder(environment, trial)
            if forwarder is not None:
                infra.append(forwarder)
            await self._buzz_json(
                trial.user, trial, "users", "set-profile", "--name",
                trial.user.agent_id,
            )
            for credential in trial.credentials:
                await self._buzz_json(
                    credential, trial, "users", "set-profile", "--name",
                    credential.agent_id,
                )
                agents.append(
                    await self._launch_agent(
                        environment=environment,
                        trial=trial,
                        credential=credential,
                        agent_class=classes[credential.agent_id],
                        trial_dir=trial_dir,
                        turn_timeout_seconds=manifest.trial_budget.timeout_seconds,
                    )
                )
            await self._wait_for_agents_ready(
                environment, agents, trial.channel_id, infra
            )
            # The task arrives exactly as it would in production Buzz: a
            # user prompt @mentioning the orchestrator. The harness never
            # speaks as any agent.
            await self._send(
                trial.user, trial, f"@{orchestrator.agent_id} {instruction}"
            )
            final_message = await asyncio.wait_for(
                self._wait_for_done(
                    environment,
                    orchestrator,
                    trial,
                    agents + infra,
                    # Only a lone agent's finished turn ends the trial; see
                    # _wait_for_done on why a team has no equivalent signal.
                    solo=agents[0] if len(agents) == 1 else None,
                ),
                timeout=manifest.trial_budget.timeout_seconds,
            )
            # `DONE:` is published before the turn's usage notification is, so
            # teardown has to wait or the trial's tokens are lost. Inside the
            # try, and only on this path: a timeout has no usage to flush.
            await self._settle_usage(environment, agents)
            await self._verify_m1_output(environment, manifest)
        finally:
            await self._stop_agents(environment, agents + infra)
            await self._collect_logs(environment, trial_dir)
            # Before bundle.write, so the transcript is listed in the bundle's
            # file index and covered by its secret scan.
            await self._collect_transcript(trial, trial_dir)
            # Accounting runs even when the trial failed or timed out: a trial
            # that burned tokens and then stalled still cost money, and
            # excluding it would bias the sweep's cost figures toward successes.
            trial_accounting = self._collect_accounting(
                trial_dir, manifest, trial, classes
            )
            bundle.write(
                trial_dir=trial_dir,
                manifest=manifest,
                trial=trial,
                accounting=trial_accounting,
                endpoints=self.endpoints,
            )

        return RuntimeResult(
            input_tokens=trial_accounting.input_tokens,
            output_tokens=trial_accounting.output_tokens,
            cost_usd=trial_accounting.cost_usd,
            metadata={
                "completion_message_id": (
                    final_message["id"] if final_message else ""
                ),
                "completion_message": (
                    final_message["content"] if final_message else ""
                ),
                # The agent stopped without posting DONE. Not an error and not a
                # zero — the verifier still scored the container — but the
                # completion protocol was dropped, and a condition that drops it
                # often is a finding, so it is recorded per trial rather than
                # inferred later from an empty message id.
                "stopped_without_done": final_message is None,
                "agent_runtime": "in-container",
                "agent_hints_enabled": False,
                "task_seed": "user-identity-prompt",
                "agent_max_rounds": {
                    credential.agent_id: (
                        classes[credential.agent_id].budget.max_calls
                        or self.max_agent_rounds
                    )
                    for credential in trial.credentials
                },
                "solo_roster": manifest.is_solo,
                # Recorded per agent because the sensitivity check that turns
                # the [Base] section off is only interpretable next to a run
                # that left it on.
                "agent_platform_prompt": {
                    credential.agent_id: classes[
                        credential.agent_id
                    ].include_platform_prompt
                    for credential in trial.credentials
                },
                **trial_accounting.to_metadata(),
            },
        )

    @staticmethod
    def _collect_accounting(
        trial_dir: Path,
        manifest: ExperimentManifest,
        trial: TrialHandle,
        classes: dict[str, AgentClass],
    ) -> accounting.TrialAccounting:
        """Price the trial from the downloaded logs, never raising.

        A defect in accounting must not destroy an otherwise complete trial: the
        run is the expensive artifact, the numbers can be recomputed from the
        bundle. An unparseable trial comes back unreconciled, which the caller
        surfaces rather than averaging in.
        """
        try:
            return accounting.collect(
                trial_dir=trial_dir,
                manifest=manifest,
                agents=[
                    (
                        credential.agent_id,
                        credential.role,
                        classes[credential.agent_id],
                    )
                    for credential in trial.credentials
                ],
            )
        except Exception as error:  # noqa: BLE001 — never lose a paid trial
            return accounting.TrialAccounting(
                reconciled=False,
                reconciliation_note=f"accounting failed: {error}",
            )

    # -- container setup ------------------------------------------------------

    async def _install_stack(self, environment: BaseEnvironment) -> None:
        """Upload the pinned Linux binaries into the task container."""
        uploads = {
            f"{REMOTE_BIN}/buzz-acp": self.buzz_acp_binary,
            f"{REMOTE_BIN}/buzz-agent": self.buzz_agent_binary,
            f"{REMOTE_BIN}/buzz-dev-mcp": self.buzz_dev_mcp_binary,
        }
        if self.relay_gateway:
            uploads[FORWARDER] = self.forwarder_binary
        for source in uploads.values():
            if not Path(source).is_file():
                raise RuntimeLaunchError(f"agent binary not found: {source}")
        result = await environment.exec(
            f"mkdir -p {REMOTE_BIN} {REMOTE_PROMPTS} {REMOTE_LOGS}"
        )
        if result.return_code != 0:
            raise RuntimeLaunchError(
                f"cannot create {REMOTE_ROOT} in the task container: "
                f"{result.stderr or result.stdout}"
            )
        for target, source in uploads.items():
            await environment.upload_file(source, target)
        await environment.exec(f"chmod 0755 {REMOTE_BIN}/*")
        # Outside REMOTE_BIN so the chmod above does not mark it executable.
        if not Path(self.ca_bundle).is_file():
            raise RuntimeLaunchError(f"CA bundle not found: {self.ca_bundle}")
        await environment.upload_file(self.ca_bundle, REMOTE_CA_BUNDLE)

    async def _start_forwarder(
        self, environment: BaseEnvironment, trial: TrialHandle
    ) -> _Agent | None:
        """Bridge the agents' canonical relay address to the real gateway.

        The relay resolves its tenant from the request ``Host`` header, so the
        agents must dial the exact authority its community row is bound to —
        ``trial.relay_ws_url``. When that address is loopback inside the task
        container but the relay lives on the Docker host, this starts the
        uploaded forwarder listening on the canonical address and pumping the
        byte stream to ``relay_gateway``. Returns ``None`` when no gateway is
        configured (the relay is reachable directly).
        """
        if not self.relay_gateway:
            return None
        # Listen on the IPv4 loopback explicitly: binding the name `localhost`
        # would pick whichever address family resolves first, while clients
        # iterate both — pinning v4 makes the pair deterministic. The Host
        # header the relay tenant-binds on comes from the URL the agents
        # dial (trial.relay_ws_url), not from the socket address.
        listen = self._ws_authority(trial.relay_ws_url).replace(
            "localhost", "127.0.0.1", 1
        )
        log = FORWARDER_LOG
        command = (
            f"{shlex.quote(FORWARDER)} {shlex.quote(listen)} "
            f"{shlex.quote(self.relay_gateway)} </dev/null "
            f">{shlex.quote(log)} 2>&1 & echo $!"
        )
        result = await environment.exec(command)
        try:
            pid = int((result.stdout or "").strip().splitlines()[-1])
        except (ValueError, IndexError) as error:
            raise RuntimeLaunchError(
                f"cannot launch relay forwarder: {result.stderr or result.stdout}"
            ) from error
        forwarder = _Agent(
            AgentCredential(
                agent_id="relay-forwarder", role="infra",
                nostr_secret_key="", nostr_pubkey="", nostr_auth_tag="",
                llm_endpoint="", llm_api_key="",
            ),
            pid, log, log,
        )
        deadline = asyncio.get_running_loop().time() + self.readiness_timeout_seconds
        while True:
            probe = await environment.exec(f"cat {shlex.quote(log)} 2>/dev/null")
            if "forwarding" in (probe.stdout or ""):
                return forwarder
            await self._raise_for_dead_agents(environment, [forwarder])
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeLaunchError(
                    "relay forwarder did not report readiness; "
                    f"see {log} in the trial artifacts"
                )
            await asyncio.sleep(self.poll_seconds)

    @staticmethod
    def _ws_authority(relay_ws_url: str) -> str:
        """``host:port`` from a ws:// URL — the forwarder's listen address."""
        if not relay_ws_url.startswith("ws://"):
            raise RuntimeLaunchError(
                "relay_gateway forwarding requires a ws:// relay_ws_url"
            )
        authority = relay_ws_url.removeprefix("ws://").split("/", 1)[0]
        if ":" not in authority:
            authority += ":80"
        return authority

    async def _launch_agent(
        self,
        *,
        environment: BaseEnvironment,
        trial: TrialHandle,
        credential: AgentCredential,
        agent_class: AgentClass,
        trial_dir: Path,
        turn_timeout_seconds: int = 0,
    ) -> _Agent:
        if not credential.llm_endpoint:
            raise RuntimeLaunchError("credential llm_endpoint must not be empty")
        endpoint = self.endpoints.get(credential.llm_endpoint)
        if endpoint is None:
            raise RuntimeLaunchError(
                f"no launch config for endpoint {credential.llm_endpoint!r}"
            )
        self._reject_identity_overrides(endpoint)
        prompt_path = self.artifact_root / agent_class.prompt.path
        self._verify_artifact(prompt_path, agent_class.prompt.sha256)
        composed = self._compose_system_prompt(
            trial_dir=trial_dir,
            trial=trial,
            credential=credential,
            persona_path=prompt_path,
        )
        remote_prompt = f"{REMOTE_PROMPTS}/{credential.agent_id}.system-prompt.md"
        await environment.upload_file(composed, remote_prompt)

        stdout_log = f"{REMOTE_LOGS}/{credential.agent_id}.stdout.log"
        stderr_log = f"{REMOTE_LOGS}/{credential.agent_id}.stderr.log"
        env = self._agent_env(
            trial=trial,
            credential=credential,
            agent_class=agent_class,
            endpoint=endpoint,
            remote_prompt=remote_prompt,
            turn_timeout_seconds=turn_timeout_seconds,
        )
        command = (
            f"{shlex.quote(f'{REMOTE_BIN}/buzz-acp')} </dev/null "
            f">{shlex.quote(stdout_log)} 2>{shlex.quote(stderr_log)} & echo $!"
        )
        result = await environment.exec(command, env=env)
        try:
            pid = int((result.stdout or "").strip().splitlines()[-1])
        except (ValueError, IndexError) as error:
            raise RuntimeLaunchError(
                f"cannot launch agent {credential.agent_id}: "
                f"{result.stderr or result.stdout}"
            ) from error
        return _Agent(credential, pid, stdout_log, stderr_log)

    def _agent_env(
        self,
        *,
        trial: TrialHandle,
        credential: AgentCredential,
        agent_class: AgentClass,
        endpoint: EndpointLaunchConfig,
        remote_prompt: str,
        turn_timeout_seconds: int = 0,
    ) -> dict[str, str]:
        """The desktop-launch environment: real acp/agent/dev-mcp wiring."""
        return {
            **self._turn_duration_env(turn_timeout_seconds),
            **endpoint.env,
            "RUST_LOG": self._stack_rust_log(endpoint.env.get("RUST_LOG")),
            # Ahead of the identity wiring because without it buzz-agent never
            # builds an HTTP client at all: see REMOTE_CA_BUNDLE. Only the file
            # is set — SSL_CERT_DIR is left alone because rustls-native-certs
            # splits it on `:` and requires every entry to be an existing
            # directory, so an empty value would name one bad path and fail
            # exactly the way this is meant to prevent.
            "SSL_CERT_FILE": REMOTE_CA_BUNDLE,
            "BUZZ_RELAY_URL": trial.relay_ws_url,
            "BUZZ_PRIVATE_KEY": credential.nostr_secret_key,
            # Desktop parity: the GUI also sets NOSTR_PRIVATE_KEY on buzz-acp
            # so buzz-dev-mcp's shim can wire git auth/signing for the agent.
            "NOSTR_PRIVATE_KEY": credential.nostr_secret_key,
            "BUZZ_AUTH_TAG": credential.nostr_auth_tag,
            "BUZZ_ACP_AGENT_COMMAND": f"{REMOTE_BIN}/buzz-agent",
            "BUZZ_ACP_AGENT_ARGS": "",
            "BUZZ_ACP_MCP_COMMAND": f"{REMOTE_BIN}/buzz-dev-mcp",
            "BUZZ_ACP_CHANNELS": trial.channel_id,
            "BUZZ_ACP_SUBSCRIBE": "mentions",
            "BUZZ_ACP_RESPOND_TO": "anyone",
            "BUZZ_ACP_NO_MEMORY": "true",
            "BUZZ_ACP_SYSTEM_PROMPT_FILE": remote_prompt,
            **self._platform_prompt_env(agent_class),
            "BUZZ_AGENT_PROVIDER": endpoint.provider,
            "BUZZ_AGENT_MODEL": credential.llm_endpoint,
            "BUZZ_AGENT_THINKING_EFFORT": THINKING_EFFORT,
            "BUZZ_AGENT_MAX_OUTPUT_TOKENS": str(
                agent_class.generation.max_output_tokens
            ),
            "BUZZ_AGENT_MAX_CONTEXT_TOKENS": str(
                agent_class.generation.context_window_tokens
            ),
            **self._compaction_env(agent_class.generation),
            "BUZZ_AGENT_MAX_ROUNDS": str(
                agent_class.budget.max_calls or self.max_agent_rounds
            ),
            # The pinned persona is the whole prompt: no hint-file or skill
            # discovery from the task filesystem (metadata reports this).
            "BUZZ_AGENT_NO_HINTS": "1",
            endpoint.api_key_env: credential.llm_api_key,
        }

    @staticmethod
    def _turn_duration_env(turn_timeout_seconds: int) -> dict[str, str]:
        """Let one turn last as long as the trial the condition budgets for.

        buzz-acp caps a single turn at 2h by default (config.rs:31). A solo
        agent is woken exactly once, so its one turn *is* the whole trial — and
        Terminal-Bench's longest tasks allow more than that. Leaving the default
        in place would cut those turns off for a reason unrelated to the task,
        and silently: the cap ends the turn without publishing anything.

        The idle timer moves with it. buzz-acp separately ends a turn after 900s
        with no ACP wire activity (config.rs:27), sized for a desktop agent whose
        longest single tool call is a 600s shell command. A graded trial breaks
        that assumption: the agent may work the terminal for a quarter of an hour
        without emitting anything the outer channel can see, and the timer fires
        as silently as the turn cap does. One cacert-fix-check trial died exactly
        that way — buzz-acp quit at 900.2s on a task Harbor allowed 1800s, having
        published nothing, and scored zero at full cost.

        Set it one second under the turn cap. That is deliberately close to
        disabling it: Harbor already enforces each task's own deadline, so a
        wedged agent is bounded either way, and the only thing the shorter timer
        adds here is a way to lose a live trial. Staying below the cap keeps
        buzz-acp's `idle_timeout < max_turn_duration` invariant, which it
        validates at startup.

        Neither is set when no budget is known, so buzz-acp's own defaults still
        apply rather than an accidental zero.
        """
        if turn_timeout_seconds <= 0:
            return {}
        return {
            "BUZZ_ACP_MAX_TURN_DURATION": str(turn_timeout_seconds),
            "BUZZ_ACP_IDLE_TIMEOUT": str(turn_timeout_seconds - 1),
        }

    @staticmethod
    def _platform_prompt_env(agent_class: AgentClass) -> dict[str, str]:
        """Suppress buzz-acp's `[Base]` section when the condition opts out.

        Set only when opting out, for the same reason the compaction knobs are:
        a variable present in the bundle should mean the experiment chose it.
        The default path leaves buzz-acp's own behaviour untouched.
        """
        if agent_class.include_platform_prompt:
            return {}
        return {"BUZZ_ACP_NO_BASE_PROMPT": "1"}

    @staticmethod
    def _compaction_env(generation: GenerationConfig) -> dict[str, str]:
        """Auto-compaction policy, omitted entirely when the manifest is silent.

        Omitting rather than passing the agent's own defaults keeps the
        container env honest about what the condition actually pins: a variable
        present in the bundle means the experiment chose it.
        """
        env: dict[str, str] = {}
        if generation.compact_at_percent is not None:
            env["BUZZ_AGENT_HANDOFF_PERCENT"] = str(generation.compact_at_percent)
        if generation.compact_at_tokens is not None:
            env["BUZZ_AGENT_HANDOFF_AT_TOKENS"] = str(generation.compact_at_tokens)
        return env

    @staticmethod
    def _stack_rust_log(configured: str | None) -> str:
        """Guarantee the harness's own targets without discarding operator intent.

        An endpoint config may legitimately raise verbosity for debugging. Rather
        than letting that silently switch off token accounting — which would show
        up as a $0.00 trial, not as an error — each directive the harness depends
        on is appended to whatever was asked for, unless that target is already
        mentioned, in which case the operator's level wins.

        Every target here is read by the harness, not just kept for a human: the
        usage target is the only token source, and the turn target is how a
        finished agent is told apart from a working one.
        """
        if not configured:
            return DEFAULT_RUST_LOG
        directives = [configured]
        for target, level in (
            (USAGE_LOG_TARGET, "debug"),
            (TURN_LOG_TARGET, "info"),
            (STREAM_LOG_TARGET, "info"),
            (TOOL_LOG_TARGET, "info"),
        ):
            if target not in configured:
                directives.append(f"{target}={level}")
        return ",".join(directives)

    # -- lifecycle -------------------------------------------------------------

    async def _wait_for_agents_ready(
        self,
        environment: BaseEnvironment,
        agents: list[_Agent],
        channel_id: str,
        infra: list[_Agent] | None = None,
    ) -> None:
        """Wait until every ACP process confirms its trial-channel subscription."""
        marker = f"subscribed to channel {channel_id}"
        deadline = asyncio.get_running_loop().time() + self.readiness_timeout_seconds
        pending = {agent.credential.agent_id: agent for agent in agents}
        while pending:
            await self._raise_for_dead_agents(environment, agents + (infra or []))
            for agent_id, agent in list(pending.items()):
                result = await environment.exec(
                    f"cat {shlex.quote(agent.stdout_log)} "
                    f"{shlex.quote(agent.stderr_log)} 2>/dev/null"
                )
                if marker in (result.stdout or ""):
                    del pending[agent_id]
            if not pending:
                return
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeLaunchError(
                    "agents did not subscribe to trial channel before readiness "
                    f"timeout: {sorted(pending)}"
                )
            await asyncio.sleep(self.poll_seconds)

    async def _wait_for_done(
        self,
        environment: BaseEnvironment,
        orchestrator: AgentCredential,
        trial: TrialHandle,
        agents: list[_Agent],
        solo: _Agent | None = None,
    ) -> dict[str, Any] | None:
        """Observe the channel as the trial user until the team stops.

        Observation only: the harness never speaks as any agent. `DONE:` from the
        orchestrator returns that message — the team reported finishing, which is
        the protocol working.

        `solo`, when given, is the run's only agent, and its turn ending is the
        second way to stop: it returns None. Nobody else can speak in the
        channel, so nothing can wake it again, and every further second is spent
        watching a process that will never act. In the first full solo sweep that
        wait came to 3.2 hours — a third of the sweep's total agent time — across
        13 trials whose work had finished in under four minutes, five of which had
        already passed their tests. The zeros were real; a third of the clock was
        not, and time is one of the four numbers this study reports.

        A team has no equivalent signal: buzz-acp logs turn ends and not turn
        starts, so a lead that ended one turn and was woken into another by a
        worker's reply is indistinguishable from a lead that has stopped for
        good. Teams therefore still wait for `DONE:` or the trial timeout, and
        catching their version of this stall needs a turn-*start* line in
        buzz-acp first.

        Either way the verifier scores the container, so the quiet stop costs no
        points. It is recorded in the trial's metadata and flagged by the sweep
        summary, so a condition that keeps dropping the `DONE:` contract shows up
        as exactly that rather than as a slow agent.
        """
        polls = 0
        while True:
            if polls % LIVENESS_EVERY == 0:
                await self._raise_for_dead_agents(environment, agents)
            polls += 1
            messages = await self._buzz_json(
                trial.user, trial,
                "messages", "get", "--channel", trial.channel_id,
                "--limit", "100",
            )
            for message in messages:
                if message.get("pubkey") == orchestrator.nostr_pubkey and str(
                    message.get("content", "")
                ).startswith("DONE:"):
                    return message
            # Ordered after the channel read on purpose: the turn that posts
            # DONE ends immediately afterwards, and that agent finished — it
            # must not be reported as having stopped without saying so.
            if solo is not None and await self._turn_ended(environment, solo):
                return None
            await asyncio.sleep(self.poll_seconds)

    @staticmethod
    async def _turn_ended(environment: BaseEnvironment, agent: _Agent) -> bool:
        """Whether buzz-acp has logged the end of a turn for this agent.

        Matches every reason a turn can end, not just the clean one: an agent
        that stopped because it hit max_tokens or its round cap is just as
        finished as one that stopped because it was done, and the difference
        belongs in the log for a human to read, not in this decision.
        """
        result = await environment.exec(
            f"cat {shlex.quote(agent.stdout_log)} "
            f"{shlex.quote(agent.stderr_log)} 2>/dev/null"
        )
        text = result.stdout or ""
        return any(marker in text for marker in TURN_ENDED_MARKERS)

    async def _settle_usage(
        self, environment: BaseEnvironment, agents: list[_Agent]
    ) -> None:
        """Give each agent the moment it needs to report what it spent.

        buzz-agent emits its `_goose/unstable/session/update` usage notification
        once per turn, immediately *before* returning the `session/prompt`
        response (buzz-agent/src/lib.rs:708). A solo agent gets exactly one turn
        per trial, so that single notification is the only record of the trial's
        tokens — and it is written after the agent has already published `DONE:`
        as a tool call.

        `_wait_for_done` returns the instant `DONE:` appears in the channel, and
        teardown kills the agent straight after. That window is a race the
        harness was losing: 24 of 89 trials in the A1 sweep reported zero tokens,
        14 of them having *passed*, which understated the run's cost by about a
        quarter and made cost-per-task unusable for comparing conditions.

        Bounded, and usually free: the notification is normally already there on
        the first poll. The budget is sized for the case where it is not —
        `DONE:` reaches the channel from inside a tool call, so the turn may
        still owe one model round-trip before it ends and reports, and for a
        thinking model that is tens of seconds, not milliseconds.
        Waiting is pointless on the timeout path — a turn that never completed
        has no usage to flush — so callers only invoke this once `DONE:` is seen.
        A miss is not fatal; the accounting note already reports an unpriced
        trial, and losing the tokens is better than hanging the sweep.
        """
        deadline = asyncio.get_running_loop().time() + self.usage_settle_seconds
        pending = {agent.credential.agent_id: agent for agent in agents}
        while pending:
            for agent_id, agent in list(pending.items()):
                result = await environment.exec(
                    f"cat {shlex.quote(agent.stdout_log)} "
                    f"{shlex.quote(agent.stderr_log)} 2>/dev/null"
                )
                if USAGE_MARKER in (result.stdout or ""):
                    del pending[agent_id]
            if not pending:
                return
            if asyncio.get_running_loop().time() >= deadline:
                # Left to the accounting layer to report as unpriced rather than
                # raised: the task itself succeeded, and failing the trial over
                # a missing cost record would throw away a real result.
                return
            await asyncio.sleep(self.poll_seconds)

    async def _raise_for_dead_agents(
        self, environment: BaseEnvironment, agents: list[_Agent]
    ) -> None:
        if not agents:
            return
        probes = "; ".join(
            f"kill -0 {agent.pid} 2>/dev/null || echo DEAD:{agent.credential.agent_id}"
            for agent in agents
        )
        result = await environment.exec(probes)
        dead = [
            line.removeprefix("DEAD:")
            for line in (result.stdout or "").splitlines()
            if line.startswith("DEAD:")
        ]
        if dead:
            raise RuntimeLaunchError(
                f"agent processes exited early: {sorted(dead)}; "
                f"see {REMOTE_LOGS} in the trial artifacts"
            )

    @staticmethod
    async def _stop_agents(
        environment: BaseEnvironment, agents: list[_Agent]
    ) -> None:
        """Terminate every process of the uploaded stack (acp, agent, mcp)."""
        if not agents:
            return
        # Match by cmdline prefix via /proc: pkill/procps is not guaranteed
        # to exist in task images, the /proc filesystem is.
        sweep = (
            "for d in /proc/[0-9]*; do "
            f"grep -aq {REMOTE_BIN} \"$d/cmdline\" 2>/dev/null "
            "&& kill -TERM \"${d#/proc/}\" 2>/dev/null; done; true"
        )
        try:
            await environment.exec(sweep)
            await asyncio.sleep(2)
            await environment.exec(sweep.replace("-TERM", "-KILL"))
        except Exception:  # noqa: BLE001 — environment may already be gone
            pass

    async def _collect_logs(
        self, environment: BaseEnvironment, trial_dir: Path
    ) -> None:
        try:
            await environment.download_dir(REMOTE_LOGS, trial_dir)
        except Exception:  # noqa: BLE001 — best effort; env may be torn down
            pass

    async def _collect_transcript(self, trial: TrialHandle, trial_dir: Path) -> None:
        """Save the channel conversation as the trial's most perishable artifact.

        The agent stack persists no session file: what one agent said to another
        exists only as relay events, and teardown archives the channel. For a
        solo condition that costs little — the stdout log implies the shape of
        the run. For a team it is the whole object of study. Who woke whom, who
        went silent, who acknowledged instead of working, and which @mention
        resolved to nobody are all questions only the transcript answers, and
        they are exactly the questions a persona rewrite has to be based on.

        Read as the trial user, the same identity that observed the channel
        while it ran, so this sees precisely what the harness was entitled to
        see. Best effort throughout: this runs in a ``finally``, and losing the
        transcript must never turn a completed trial into a failed one.
        """
        try:
            messages = await self._buzz_json(
                trial.user, trial,
                "messages", "get", "--channel", trial.channel_id,
                "--limit", str(TRANSCRIPT_LIMIT),
            )
        except Exception:  # noqa: BLE001 — a lost transcript is not a failed trial
            return
        if not isinstance(messages, list):
            return

        names = {
            credential.nostr_pubkey: credential.agent_id
            for credential in (*trial.credentials, trial.user)
        }
        ordered = sorted(
            (message for message in messages if isinstance(message, dict)),
            key=lambda message: message.get("created_at") or 0,
        )
        payload = {
            "channel_id": trial.channel_id,
            "message_count": len(ordered),
            # The relay caps what one query returns. If the cap was reached the
            # earliest messages are missing, and a reader comparing a chatty
            # condition against a terse one would silently be comparing a
            # truncated record against a complete one.
            "truncated": len(messages) >= TRANSCRIPT_LIMIT,
            "messages": [
                # Author resolved to the roster id: a transcript addressed only
                # by pubkey cannot be read without cross-referencing, which in
                # practice means it does not get read.
                {"author": names.get(message.get("pubkey"), "unknown"), **message}
                for message in ordered
            ],
        }
        try:
            (trial_dir / "transcript.json").write_text(
                json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8"
            )
        except OSError:
            pass

    # -- Buzz CLI as the trial user / provisioning identities -------------------

    @staticmethod
    async def _verify_m1_output(
        environment: BaseEnvironment, manifest: ExperimentManifest
    ) -> None:
        """Fail M1 immediately unless the artifact satisfies the grader contract."""
        if manifest.condition != "M1-hello-world":
            return
        result = await environment.exec(
            'python3 -c "from pathlib import Path; '
            "p = Path('/app/hello.txt'); "
            "assert p.is_file() and p.read_text().strip() == 'Hello, world!'\""
        )
        if result.return_code != 0:
            detail = (
                result.stderr or result.stdout or "grader-equivalent check failed"
            ).strip()
            raise RuntimeLaunchError(
                "M1 pre-verifier sanity probe failed: /app/hello.txt must exist "
                f"and its stripped text must equal 'Hello, world!' ({detail})"
            )

    async def _send(
        self, credential: AgentCredential, trial: TrialHandle, content: str
    ) -> None:
        await self._buzz_json(
            credential, trial,
            "messages", "send", "--channel", trial.channel_id,
            "--content", content,
        )

    async def _buzz_json(
        self, credential: AgentCredential, trial: TrialHandle, *args: str
    ) -> Any:
        process = await asyncio.create_subprocess_exec(
            self.buzz_cli_binary,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={
                **os.environ,
                "BUZZ_RELAY_URL": self._user_relay_url(trial),
                "BUZZ_PRIVATE_KEY": credential.nostr_secret_key,
                "BUZZ_AUTH_TAG": credential.nostr_auth_tag,
            },
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            raise RuntimeLaunchError(
                f"buzz {shlex.join(args)} exited {process.returncode}: "
                f"{stderr.decode(errors='replace').strip()}"
            )
        try:
            return json.loads(stdout)
        except json.JSONDecodeError as error:
            raise RuntimeLaunchError("buzz returned invalid JSON") from error

    @staticmethod
    def _user_relay_url(trial: TrialHandle) -> str:
        """The relay as reachable from the HOST (user identity, harness).

        ``trial.relay_ws_url`` is the container view (the agents' runtime);
        ``trial.user_relay_url`` is the host view. Fall back to deriving an
        http URL from the ws URL for handles minted before v1.2.
        """
        if trial.user_relay_url:
            return trial.user_relay_url
        return BuzzContainerRuntime._cli_relay_url(trial.relay_ws_url)

    @staticmethod
    def _cli_relay_url(relay_ws_url: str) -> str:
        if relay_ws_url.startswith("ws://"):
            return f"http://{relay_ws_url.removeprefix('ws://')}"
        if relay_ws_url.startswith("wss://"):
            return f"https://{relay_ws_url.removeprefix('wss://')}"
        raise RuntimeLaunchError("trial relay_ws_url must use ws:// or wss://")

    # -- manifest plumbing -------------------------------------------------------

    @staticmethod
    def _classes_by_agent_id(
        manifest: ExperimentManifest, credentials: tuple[AgentCredential, ...]
    ) -> dict[str, AgentClass]:
        by_id = {entry.id: entry for entry in manifest.roster}
        result: dict[str, AgentClass] = {}
        for credential in credentials:
            class_id, separator, index = credential.agent_id.rpartition("-")
            match = by_id.get(class_id)
            if not separator or not index.isdigit() or match is None:
                raise RuntimeLaunchError(
                    f"credential {credential.agent_id!r} does not match a roster class"
                )
            if credential.role != match.kind:
                raise RuntimeLaunchError(
                    f"credential {credential.agent_id!r} role does not match manifest"
                )
            result[credential.agent_id] = match
        return result

    @staticmethod
    def _verify_artifact(path: Path, expected_sha256: str) -> None:
        import hashlib

        try:
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as error:
            raise RuntimeLaunchError(f"cannot read prompt {path}: {error}") from error
        if actual != expected_sha256:
            raise RuntimeLaunchError(
                f"prompt hash mismatch for {path}: expected {expected_sha256}, got {actual}"
            )

    def _compose_system_prompt(
        self,
        *,
        trial_dir: Path,
        trial: TrialHandle,
        credential: AgentCredential,
        persona_path: Path,
    ) -> Path:
        """Append the trial's team roster to the pinned persona.

        The analogue of a production Buzz workspace's team context: each agent
        knows its own identity, its channel, the user it reports to, and its
        teammates' names, pubkeys, and roles from its system prompt — it never
        has to discover them over the relay.
        """
        persona = persona_path.read_text(encoding="utf-8")
        teammates = [
            teammate
            for teammate in trial.credentials
            if teammate.agent_id != credential.agent_id
        ]
        lines = [
            "",
            "## Your team",
            "",
            f"You are `{credential.agent_id}` (pubkey `{credential.nostr_pubkey}`).",
            f"The team coordinates in Buzz channel `{trial.channel_id}`.",
            f"Tasks come from the user `{trial.user.agent_id}` "
            f"(pubkey `{trial.user.nostr_pubkey}`); address your final report "
            "to them.",
            "",
        ]
        if teammates:
            lines += ["| Name | Role | Pubkey |", "|------|------|--------|"]
            lines += [
                # The manifest's role, not the kind: personas address each
                # other by job ("the teammate whose Role column reads
                # `critic`"), and a table that said `worker` twice would leave
                # a lead unable to tell its implementer from its verifier.
                f"| {teammate.agent_id} | {teammate.manifest_role or teammate.role} "
                f"| `{teammate.nostr_pubkey}` |"
                for teammate in teammates
            ]
        else:
            # Solo baseline: saying "no teammates" explicitly stops the agent
            # burning rounds trying to delegate to a roster that isn't there.
            lines.append(
                "You have no teammates on this trial — you are working alone. "
                "Do the work yourself; there is nobody to delegate to."
            )
        composed = persona + "\n".join(lines) + "\n"
        path = trial_dir / f"{credential.agent_id}.system-prompt.md"
        path.write_text(composed, encoding="utf-8")
        path.chmod(0o600)
        return path

    @staticmethod
    def _reject_identity_overrides(endpoint: EndpointLaunchConfig) -> None:
        forbidden = {
            "BUZZ_RELAY_URL",
            "BUZZ_PRIVATE_KEY",
            "BUZZ_AUTH_TAG",
            "BUZZ_ACP_CHANNELS",
            "BUZZ_ACP_MCP_COMMAND",
            "BUZZ_ACP_AGENT_COMMAND",
        }
        overlap = forbidden & endpoint.env.keys()
        if overlap:
            raise RuntimeLaunchError(
                f"endpoint env cannot override trial identity: {sorted(overlap)}"
            )
