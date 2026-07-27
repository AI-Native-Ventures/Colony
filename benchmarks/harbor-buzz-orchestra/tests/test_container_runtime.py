"""The container runtime must launch the production stack, unmodified."""

import hashlib
import json
import re
from pathlib import Path

import pytest
from harbor.environments.base import ExecResult

from harbor_buzz_orchestra.manifest import ExperimentManifest
from harbor_buzz_orchestra.provisioning import AgentCredential, TrialHandle
from harbor_buzz_orchestra.container_runtime import (
    DEFAULT_MAX_AGENT_ROUNDS,
    REMOTE_BIN,
    REMOTE_CA_BUNDLE,
    REMOTE_LOGS,
    BuzzContainerRuntime,
    EndpointLaunchConfig,
    RuntimeLaunchError,
)


def write_manifest(
    tmp_path: Path, *, include_platform_prompt: bool = True
) -> ExperimentManifest:
    prompt = tmp_path / "prompt.md"
    prompt.write_text("prompt", encoding="utf-8")
    digest = hashlib.sha256(prompt.read_bytes()).hexdigest()
    roster_entry = {
        "count": 1,
        "model_revision": "r1",
        "prompt": {"path": "prompt.md", "sha256": digest},
        "include_platform_prompt": include_platform_prompt,
        "generation": {"max_output_tokens": 100, "context_window_tokens": 1000},
    }
    return ExperimentManifest.load(
        {
            "condition": "test",
            "roster": [
                {"id": "orch", "kind": "orchestrator", "role": "lead",
                 "endpoint": "orch-model", **roster_entry},
                {"id": "worker", "kind": "worker", "role": "implementer",
                 "endpoint": "worker-model", **roster_entry},
            ],
            "prices": {
                name: {
                    "input_per_million_usd": 0,
                    "cached_input_per_million_usd": 0,
                    "output_per_million_usd": 0,
                }
                for name in ("orch-model", "worker-model")
            },
            "trial_budget": {"timeout_seconds": 30},
        }
    )


def credential(agent_id, role, endpoint, manifest_role=""):
    return AgentCredential(
        agent_id=agent_id,
        role=role,
        manifest_role=manifest_role,
        nostr_secret_key=f"secret-{agent_id}",
        nostr_pubkey=f"pubkey-{agent_id}",
        nostr_auth_tag="[]",
        llm_endpoint=endpoint,
        llm_api_key=f"key-{agent_id}",
    )


def user_credential():
    return AgentCredential(
        agent_id="user",
        role="user",
        nostr_secret_key="secret-user",
        nostr_pubkey="pubkey-user",
        nostr_auth_tag="[]",
        llm_endpoint="",
        llm_api_key="",
    )


def trial_handle(credentials, user_relay_url=""):
    return TrialHandle(
        run_id="run",
        trial_id="trial",
        manifest_hash="hash",
        relay_ws_url="ws://host.docker.internal:3600",
        channel_id="channel",
        credentials=credentials,
        user=user_credential(),
        user_relay_url=user_relay_url,
    )


def runtime(tmp_path, **kwargs):
    return BuzzContainerRuntime(
        logs_dir=tmp_path / "logs",
        artifact_root=tmp_path,
        endpoints={
            "orch-model": EndpointLaunchConfig("anthropic", "ANTHROPIC_API_KEY"),
            "worker-model": EndpointLaunchConfig("anthropic", "ANTHROPIC_API_KEY"),
        },
        **kwargs,
    )


class Environment:
    """Records execs/uploads; scripted stdout per command substring."""

    def __init__(self, responses=None):
        self.commands = []
        self.uploads = []
        self.responses = responses or {}

    async def exec(self, command, env=None, **kwargs):
        self.commands.append((command, env))
        for needle, result in self.responses.items():
            if needle in command:
                return result
        return ExecResult(stdout="", stderr="", return_code=0)

    async def upload_file(self, source, target):
        self.uploads.append((str(source), target))

    async def download_dir(self, source, target):
        pass


def test_maps_credentials_exactly_and_rejects_role_mismatch(tmp_path):
    manifest = write_manifest(tmp_path)
    credentials = (
        credential("orch-1", "orchestrator", "orch-model"),
        credential("worker-1", "worker", "worker-model"),
    )
    assert set(runtime(tmp_path)._classes_by_agent_id(manifest, credentials)) == {
        "orch-1",
        "worker-1",
    }
    bad = (credential("worker-1", "orchestrator", "worker-model"),)
    with pytest.raises(RuntimeLaunchError, match="role"):
        runtime(tmp_path)._classes_by_agent_id(manifest, bad)


def test_prompt_hash_and_identity_override_are_fail_closed(tmp_path):
    manifest = write_manifest(tmp_path)
    prompt_ref = manifest.roster[0].prompt
    runtime(tmp_path)._verify_artifact(tmp_path / prompt_ref.path, prompt_ref.sha256)
    (tmp_path / prompt_ref.path).write_text("changed", encoding="utf-8")
    with pytest.raises(RuntimeLaunchError, match="hash mismatch"):
        runtime(tmp_path)._verify_artifact(
            tmp_path / prompt_ref.path, prompt_ref.sha256
        )

    endpoint = EndpointLaunchConfig(
        "anthropic", "ANTHROPIC_API_KEY", {"BUZZ_ACP_MCP_COMMAND": "evil"}
    )
    with pytest.raises(RuntimeLaunchError, match="identity"):
        runtime(tmp_path)._reject_identity_overrides(endpoint)


def test_user_relay_url_prefers_host_view(tmp_path):
    rt = runtime(tmp_path)
    # v1.2 handles carry the host view for the trial user explicitly.
    assert (
        rt._user_relay_url(trial_handle((), user_relay_url="http://localhost:3600"))
        == "http://localhost:3600"
    )
    # pre-v1.2 handles fall back to deriving http from the agents' ws view.
    assert (
        rt._user_relay_url(trial_handle(()))
        == "http://host.docker.internal:3600"
    )
    with pytest.raises(RuntimeLaunchError, match="ws://"):
        rt._cli_relay_url("http://relay")


async def test_install_stack_uploads_the_pinned_stack(tmp_path):
    binaries = {}
    for name in ("buzz-acp", "buzz-agent", "buzz-dev-mcp"):
        path = tmp_path / name
        path.write_text("#!binary")
        binaries[name] = str(path)
    rt = runtime(
        tmp_path,
        buzz_acp_binary=binaries["buzz-acp"],
        buzz_agent_binary=binaries["buzz-agent"],
        buzz_dev_mcp_binary=binaries["buzz-dev-mcp"],
    )
    environment = Environment()
    await rt._install_stack(environment)
    assert {target for _, target in environment.uploads} == {
        f"{REMOTE_BIN}/buzz-acp",
        f"{REMOTE_BIN}/buzz-agent",
        f"{REMOTE_BIN}/buzz-dev-mcp",
        REMOTE_CA_BUNDLE,
    }
    assert any("chmod 0755" in cmd for cmd, _ in environment.commands)


async def test_install_stack_requires_binaries_on_disk(tmp_path):
    rt = runtime(tmp_path, buzz_acp_binary=str(tmp_path / "missing"))
    with pytest.raises(RuntimeLaunchError, match="binary not found"):
        await rt._install_stack(Environment())


async def test_trust_anchors_are_shipped_because_task_images_may_have_none(tmp_path):
    """A task image without ca-certificates must not cost the agent the trial.

    buzz-agent links reqwest's rustls feature, which loads roots from the
    *container's* trust store. Several Terminal-Bench images ship none, so
    `Client::builder().build()` fails and the agent exits before it reaches the
    relay — scoring those tasks zero for every condition, for a reason that has
    nothing to do with the model. Uploading our own bundle and pointing
    SSL_CERT_FILE at it is what makes those tasks measurable at all.
    """
    binaries = {}
    for name in ("buzz-acp", "buzz-agent", "buzz-dev-mcp"):
        path = tmp_path / name
        path.write_text("#!binary")
        binaries[name] = str(path)
    bundle_path = tmp_path / "cacert.pem"
    bundle_path.write_text("-----BEGIN CERTIFICATE-----\n")
    rt = runtime(
        tmp_path,
        buzz_acp_binary=binaries["buzz-acp"],
        buzz_agent_binary=binaries["buzz-agent"],
        buzz_dev_mcp_binary=binaries["buzz-dev-mcp"],
        ca_bundle=str(bundle_path),
    )
    environment = Environment()
    await rt._install_stack(environment)
    assert (str(bundle_path), REMOTE_CA_BUNDLE) in environment.uploads
    # Outside REMOTE_BIN, so the executable chmod does not apply to it.
    assert not REMOTE_CA_BUNDLE.startswith(f"{REMOTE_BIN}/")

    orch = credential("orch-1", "orchestrator", "orch-model")
    env = rt._agent_env(
        trial=trial_handle((orch,)),
        credential=orch,
        agent_class=write_manifest(tmp_path).roster[0],
        endpoint=EndpointLaunchConfig("anthropic", "ANTHROPIC_API_KEY"),
        remote_prompt="/opt/buzz/prompts/orch-1.system-prompt.md",
    )
    assert env["SSL_CERT_FILE"] == REMOTE_CA_BUNDLE
    # Never SSL_CERT_DIR: rustls-native-certs splits it on ':' and requires
    # every entry to be an existing directory, so an empty value names one bad
    # path and fails exactly the way this is meant to prevent.
    assert "SSL_CERT_DIR" not in env


async def test_install_stack_requires_the_ca_bundle_on_disk(tmp_path):
    """Fail loudly at upload rather than as an opaque agent crash later."""
    for name in ("buzz-acp", "buzz-agent", "buzz-dev-mcp"):
        (tmp_path / name).write_text("#!binary")
    rt = runtime(
        tmp_path,
        buzz_acp_binary=str(tmp_path / "buzz-acp"),
        buzz_agent_binary=str(tmp_path / "buzz-agent"),
        buzz_dev_mcp_binary=str(tmp_path / "buzz-dev-mcp"),
        ca_bundle=str(tmp_path / "missing.pem"),
    )
    with pytest.raises(RuntimeLaunchError, match="CA bundle not found"):
        await rt._install_stack(Environment())


async def test_forwarder_bridges_the_canonical_relay_address(tmp_path):
    from harbor_buzz_orchestra.container_runtime import FORWARDER

    forwarder = tmp_path / "relay-forwarder"
    forwarder.write_text("ELF")
    rt = runtime(
        tmp_path,
        relay_gateway="host.docker.internal:3600",
        forwarder_binary=str(forwarder),
    )
    trial = TrialHandle(
        run_id="run", trial_id="trial", manifest_hash="hash",
        relay_ws_url="ws://localhost:3600", channel_id="channel",
        credentials=(), user=user_credential(),
    )
    environment = Environment(
        responses={
            FORWARDER: ExecResult(stdout="99\n", stderr="", return_code=0),
            "cat ": ExecResult(
                stdout="forwarding 127.0.0.1:3600 -> host.docker.internal:3600",
                stderr="", return_code=0,
            ),
        }
    )
    agent = await rt._start_forwarder(environment, trial)
    assert agent is not None and agent.pid == 99
    launch = next(cmd for cmd, _ in environment.commands if FORWARDER in cmd)
    # Listens on the canonical loopback (host-header bound), targets the gateway.
    assert "127.0.0.1:3600" in launch
    assert "host.docker.internal:3600" in launch

    # No gateway configured: the relay is reachable directly, no forwarder.
    assert await runtime(tmp_path)._start_forwarder(Environment(), trial) is None
    with pytest.raises(RuntimeLaunchError, match="ws://"):
        rt._ws_authority("http://relay")


@pytest.mark.parametrize(
    ("configured", "expected"),
    [(None, str(DEFAULT_MAX_AGENT_ROUNDS)), (7, "7")],
)
async def test_launch_wires_the_desktop_environment(tmp_path, configured, expected):
    manifest = write_manifest(tmp_path)
    agent_class = manifest.roster[0]
    if configured is not None:
        agent_class = agent_class.model_copy(
            update={
                "budget": agent_class.budget.model_copy(
                    update={"max_calls": configured}
                )
            }
        )
    orch = credential("orch-1", "orchestrator", "orch-model")
    trial = trial_handle((orch,))
    environment = Environment(
        responses={"buzz-acp": ExecResult(stdout="4242\n", stderr="", return_code=0)}
    )
    agent = await runtime(tmp_path)._launch_agent(
        environment=environment,
        trial=trial,
        credential=orch,
        agent_class=agent_class,
        trial_dir=tmp_path,
    )
    assert agent.pid == 4242
    command, env = environment.commands[-1]
    assert f"{REMOTE_BIN}/buzz-acp" in command
    # The real product wiring: acp spawns buzz-agent, which gets buzz-dev-mcp.
    assert env["BUZZ_ACP_AGENT_COMMAND"] == f"{REMOTE_BIN}/buzz-agent"
    assert env["BUZZ_ACP_MCP_COMMAND"] == f"{REMOTE_BIN}/buzz-dev-mcp"
    assert env["BUZZ_RELAY_URL"] == trial.relay_ws_url
    assert env["BUZZ_PRIVATE_KEY"] == orch.nostr_secret_key
    assert env["NOSTR_PRIVATE_KEY"] == orch.nostr_secret_key
    assert env["BUZZ_AGENT_NO_HINTS"] == "1"
    assert env["BUZZ_AGENT_MAX_ROUNDS"] == expected
    assert env["BUZZ_ACP_SYSTEM_PROMPT_FILE"].endswith("orch-1.system-prompt.md")
    # The composed prompt was uploaded into the container.
    assert any(
        target == env["BUZZ_ACP_SYSTEM_PROMPT_FILE"]
        for _, target in environment.uploads
    )


async def test_one_turn_may_last_as_long_as_the_trial_budget(tmp_path):
    """A solo agent's single turn is the whole trial, so the caps must agree.

    buzz-acp defaults to a 2h per-turn ceiling, and Terminal-Bench's longest
    tasks allow more. Leaving the default would end those turns mid-task with
    nothing published — the silent failure mode the round cap also has.
    """
    manifest = write_manifest(tmp_path)
    orch = credential("orch-1", "orchestrator", "orch-model")
    env = runtime(tmp_path)._agent_env(
        trial=trial_handle((orch,)),
        credential=orch,
        agent_class=manifest.roster[0],
        endpoint=EndpointLaunchConfig("anthropic", "ANTHROPIC_API_KEY"),
        remote_prompt="/opt/buzz/prompts/orch-1.system-prompt.md",
        turn_timeout_seconds=12000,
    )
    assert env["BUZZ_ACP_MAX_TURN_DURATION"] == "12000"

    # The idle timer moves with the cap, or it becomes the deadline that
    # actually fires: at its 900s default it ended a live trial on a task
    # Harbor allowed 1800s. One second under keeps buzz-acp's
    # idle < max_turn startup invariant.
    assert env["BUZZ_ACP_IDLE_TIMEOUT"] == "11999"

    # Unknown budget leaves buzz-acp's own default alone rather than sending 0,
    # which would be read as "no time at all".
    unset = runtime(tmp_path)._agent_env(
        trial=trial_handle((orch,)),
        credential=orch,
        agent_class=manifest.roster[0],
        endpoint=EndpointLaunchConfig("anthropic", "ANTHROPIC_API_KEY"),
        remote_prompt="/opt/buzz/prompts/orch-1.system-prompt.md",
    )
    assert "BUZZ_ACP_MAX_TURN_DURATION" not in unset
    assert "BUZZ_ACP_IDLE_TIMEOUT" not in unset


async def test_launch_enables_the_usage_log_target(tmp_path):
    """Without this directive every trial silently reports zero tokens."""
    manifest = write_manifest(tmp_path)
    orch = credential("orch-1", "orchestrator", "orch-model")
    environment = Environment(
        responses={"buzz-acp": ExecResult(stdout="1\n", stderr="", return_code=0)}
    )
    await runtime(tmp_path)._launch_agent(
        environment=environment,
        trial=trial_handle((orch,)),
        credential=orch,
        agent_class=manifest.roster[0],
        trial_dir=tmp_path,
    )
    _, env = environment.commands[-1]
    assert "acp::usage=debug" in env["RUST_LOG"]


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        (None, "buzz_acp=info,acp::usage=debug"),
        # Operator verbosity is preserved, but never at the cost of accounting.
        ("buzz_acp=trace", "buzz_acp=trace,acp::usage=debug"),
        ("acp::usage=trace", "acp::usage=trace"),
    ],
)
def test_usage_rust_log_never_drops_the_usage_target(configured, expected):
    assert BuzzContainerRuntime._usage_rust_log(configured) == expected


def test_solo_prompt_states_there_is_nobody_to_delegate_to(tmp_path):
    """A solo agent told nothing about its team burns rounds hunting for one."""
    rt = runtime(tmp_path)
    solo = credential("solo-1", "orchestrator", "orch-model")
    persona = tmp_path / "persona.md"
    persona.write_text("# Solo\n", encoding="utf-8")

    composed = rt._compose_system_prompt(
        trial_dir=tmp_path,
        trial=trial_handle((solo,)),
        credential=solo,
        persona_path=persona,
    ).read_text(encoding="utf-8")

    assert "no teammates" in composed
    assert "| Name | Role | Pubkey |" not in composed


async def test_solo_roster_runs_and_is_priced(tmp_path, monkeypatch):
    """The zero-worker baseline must run, and must not report $0.00 by default."""
    manifest = ExperimentManifest.load(
        {
            "condition": "solo",
            "roster": [
                {
                    "id": "solo", "kind": "orchestrator", "role": "lead", "count": 1,
                    "endpoint": "orch-model", "model_revision": "r1",
                    "prompt": {
                        "path": "prompt.md",
                        "sha256": hashlib.sha256(b"prompt").hexdigest(),
                    },
                    "generation": {
                        "max_output_tokens": 100, "context_window_tokens": 1000
                    },
                }
            ],
            "prices": {
                "orch-model": {
                    "input_per_million_usd": 10,
                    "cached_input_per_million_usd": 1,
                    "output_per_million_usd": 30,
                }
            },
            "trial_budget": {"timeout_seconds": 30},
        }
    )
    (tmp_path / "prompt.md").write_text("prompt", encoding="utf-8")
    solo = credential("solo-1", "orchestrator", "orch-model")
    trial = trial_handle((solo,))
    rt = runtime(tmp_path, poll_seconds=0)

    class SoloEnvironment(Environment):
        async def exec(self, command, env=None, **kwargs):
            self.commands.append((command, env))
            if "buzz-acp" in command:
                return ExecResult(stdout="99\n", stderr="", return_code=0)
            if command.startswith("cat "):
                return ExecResult(
                    stdout="subscribed to channel channel\n", stderr="", return_code=0
                )
            return ExecResult(stdout="", stderr="", return_code=0)

        async def download_dir(self, source, target):
            # Stand in for the real log download.
            Path(target).mkdir(parents=True, exist_ok=True)
            (Path(target) / "solo-1.stdout.log").write_text(
                "2026-07-26T00:00:00Z DEBUG acp::usage: goose usage update "
                "session_id=s input=2000000 output=1000000\n",
                encoding="utf-8",
            )

    monkeypatch.setattr(rt, "_install_stack", lambda environment: _noop())
    monkeypatch.setattr(
        rt, "_wait_for_done",
        lambda *a, **k: _value({"id": "m1", "content": "DONE: done"}),
    )

    async def buzz_json(*args, **kwargs):
        return []

    monkeypatch.setattr(rt, "_buzz_json", buzz_json)

    result = await rt.run(
        instruction="do the thing",
        environment=SoloEnvironment(),
        manifest=manifest,
        trial=trial,
    )

    assert result.input_tokens == 2_000_000
    assert result.output_tokens == 1_000_000
    # $10/Mtok in + $30/Mtok out
    assert result.cost_usd == pytest.approx(20.0 + 30.0)
    assert result.metadata["solo_roster"] is True
    assert result.metadata["accounting_reconciled"] is True
    # The bundle landed next to the logs.
    summary = json.loads((tmp_path / "logs" / "buzz" / "summary.json").read_text())
    assert summary["solo_roster"] is True
    assert summary["secret_scan"]["clean"] is True


async def _noop():
    return None


async def _value(value):
    return value


def test_runtime_rejects_unbounded_agent_rounds(tmp_path):
    with pytest.raises(ValueError, match="positive"):
        runtime(tmp_path, max_agent_rounds=0)
    with pytest.raises(ValueError, match="positive"):
        runtime(tmp_path, readiness_timeout_seconds=0)


async def test_wait_for_agents_ready_requires_every_channel_subscription(tmp_path):
    rt = runtime(tmp_path, poll_seconds=0)
    logs = {"orch-1": "", "worker-1": ""}

    class ReadyEnvironment(Environment):
        polls = 0

        async def exec(self, command, env=None, **kwargs):
            if command.startswith("cat "):
                agent_id = re.search(r"([\w-]+)\.stdout\.log", command).group(1)
                return ExecResult(
                    stdout=logs[agent_id], stderr="", return_code=0
                )
            return ExecResult(stdout="", stderr="", return_code=0)

    from harbor_buzz_orchestra.container_runtime import _Agent

    agents = [
        _Agent(
            credential(agent_id, "worker", "worker-model"),
            pid=1,
            stdout_log=f"{REMOTE_LOGS}/{agent_id}.stdout.log",
            stderr_log=f"{REMOTE_LOGS}/{agent_id}.stderr.log",
        )
        for agent_id in logs
    ]
    logs["orch-1"] = "subscribed to channel trial-channel\n"
    logs["worker-1"] = "subscribed to channel trial-channel\n"
    await rt._wait_for_agents_ready(ReadyEnvironment(), agents, "trial-channel")

    logs["worker-1"] = ""
    rt_timeout = runtime(tmp_path, poll_seconds=0, readiness_timeout_seconds=0.01)
    with pytest.raises(RuntimeLaunchError, match="worker-1"):
        await rt_timeout._wait_for_agents_ready(
            ReadyEnvironment(), agents, "trial-channel"
        )


async def test_dead_agent_processes_fail_the_trial(tmp_path):
    from harbor_buzz_orchestra.container_runtime import _Agent

    agents = [
        _Agent(credential("worker-1", "worker", "worker-model"), 7, "o", "e")
    ]
    environment = Environment(
        responses={
            "kill -0": ExecResult(stdout="DEAD:worker-1\n", stderr="", return_code=0)
        }
    )
    with pytest.raises(RuntimeLaunchError, match="worker-1"):
        await runtime(tmp_path)._raise_for_dead_agents(environment, agents)


@pytest.mark.parametrize(
    ("condition", "return_code", "raises"),
    [
        ("M1-hello-world", 0, False),
        ("M1-hello-world", 1, True),
        ("other", 1, False),
    ],
)
async def test_m1_output_probe_matches_grader_and_is_condition_scoped(
    tmp_path, condition, return_code, raises
):
    manifest = write_manifest(tmp_path).model_copy(update={"condition": condition})
    environment = Environment(
        responses={
            "hello.txt": ExecResult(stdout="", stderr="", return_code=return_code)
        }
    )
    if raises:
        with pytest.raises(RuntimeLaunchError, match="/app/hello.txt"):
            await runtime(tmp_path)._verify_m1_output(environment, manifest)
    else:
        await runtime(tmp_path)._verify_m1_output(environment, manifest)
    probed = [cmd for cmd, _ in environment.commands if "hello.txt" in cmd]
    assert bool(probed) == (condition == "M1-hello-world")


async def test_wait_for_done_requires_orchestrator_authorship(tmp_path, monkeypatch):
    rt = runtime(tmp_path, poll_seconds=0)
    orch = credential("orch-1", "orchestrator", "orch-model")
    trial = trial_handle((orch,))
    rounds = iter(
        [
            [{"id": "1", "pubkey": "someone-else", "content": "DONE: fake"}],
            [{"id": "2", "pubkey": orch.nostr_pubkey, "content": "DONE: real"}],
        ]
    )
    observers = []

    async def buzz_json(credential, *args, **kwargs):
        observers.append(credential.agent_id)
        return next(rounds)

    monkeypatch.setattr(rt, "_buzz_json", buzz_json)
    result = await rt._wait_for_done(Environment(), orch, trial, [])
    assert json.dumps(result).find("real") > 0
    # observation happens as the trial user, never as an agent identity
    assert set(observers) == {"user"}


async def test_transcript_is_saved_in_author_order_with_names(tmp_path, monkeypatch):
    """The transcript is the only record of who said what to whom.

    Ordered oldest-first and keyed by roster id, because the reason to keep it
    is reading a team's turn-taking — a pubkey-keyed reverse-chronological dump
    answers no question anyone actually asks of it.
    """
    rt = runtime(tmp_path, poll_seconds=0)
    orch = credential("orch-1", "orchestrator", "orch-model", "lead")
    worker = credential("worker-1", "worker", "worker-model", "implementer")
    trial = trial_handle((orch, worker))

    async def buzz_json(credential, *args, **kwargs):
        return [
            {"id": "3", "pubkey": orch.nostr_pubkey, "content": "DONE: x", "created_at": 3},
            {"id": "1", "pubkey": trial.user.nostr_pubkey, "content": "@orch-1 go", "created_at": 1},
            {"id": "2", "pubkey": worker.nostr_pubkey, "content": "@orch-1 done", "created_at": 2},
        ]

    monkeypatch.setattr(rt, "_buzz_json", buzz_json)
    await rt._collect_transcript(trial, tmp_path)

    saved = json.loads((tmp_path / "transcript.json").read_text())
    assert saved["channel_id"] == trial.channel_id
    assert saved["message_count"] == 3
    assert saved["truncated"] is False
    assert [m["author"] for m in saved["messages"]] == ["user", "worker-1", "orch-1"]
    assert saved["messages"][0]["content"] == "@orch-1 go"


async def test_a_lost_transcript_never_fails_a_finished_trial(tmp_path, monkeypatch):
    """This runs in a finally; a relay hiccup must not mask the real outcome."""
    rt = runtime(tmp_path, poll_seconds=0)
    orch = credential("orch-1", "orchestrator", "orch-model")
    trial = trial_handle((orch,))

    async def exploding(*args, **kwargs):
        raise RuntimeLaunchError("relay gone")

    monkeypatch.setattr(rt, "_buzz_json", exploding)
    await rt._collect_transcript(trial, tmp_path)
    assert not (tmp_path / "transcript.json").exists()


def test_composed_system_prompt_carries_persona_and_team_roster(tmp_path):
    rt = runtime(tmp_path)
    orch = credential("orch-1", "orchestrator", "orch-model")
    worker_1 = credential("worker-1", "worker", "worker-model")
    worker_2 = credential("worker-2", "worker", "worker-model")
    trial = trial_handle((orch, worker_1, worker_2))
    persona = tmp_path / "persona.md"
    persona.write_text("# Persona body\n", encoding="utf-8")

    path = rt._compose_system_prompt(
        trial_dir=tmp_path,
        trial=trial,
        credential=orch,
        persona_path=persona,
    )

    composed = path.read_text(encoding="utf-8")
    assert composed.startswith("# Persona body\n")
    assert "You are `orch-1` (pubkey `pubkey-orch-1`)" in composed
    assert f"channel `{trial.channel_id}`" in composed
    assert "user `user` (pubkey `pubkey-user`)" in composed
    # roster lists teammates, never the agent itself
    assert "| worker-1 | worker | `pubkey-worker-1` |" in composed
    assert "| worker-2 | worker | `pubkey-worker-2` |" in composed
    assert "| orch-1 " not in composed
    assert path.stat().st_mode & 0o777 == 0o600


async def test_stop_agents_sweeps_the_uploaded_stack(tmp_path):
    from harbor_buzz_orchestra.container_runtime import _Agent

    environment = Environment()
    agents = [_Agent(credential("orch-1", "orchestrator", "orch-model"), 1, "o", "e")]
    await BuzzContainerRuntime._stop_agents(environment, agents)
    sweeps = [cmd for cmd, _ in environment.commands if REMOTE_BIN in cmd]
    assert len(sweeps) == 2
    assert "kill -TERM" in sweeps[0] and "kill -KILL" in sweeps[1]


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        # Silent manifest: nothing pinned, so the agent's own defaults apply
        # (90%, 272k ceiling) and the container env says so by omission.
        ({}, {}),
        (
            {"compact_at_tokens": 272_000},
            {"BUZZ_AGENT_HANDOFF_AT_TOKENS": "272000"},
        ),
        (
            {"compact_at_percent": 30},
            {"BUZZ_AGENT_HANDOFF_PERCENT": "30"},
        ),
        (
            {"compact_at_percent": 30, "compact_at_tokens": 272_000},
            {
                "BUZZ_AGENT_HANDOFF_PERCENT": "30",
                "BUZZ_AGENT_HANDOFF_AT_TOKENS": "272000",
            },
        ),
    ],
)
async def test_compaction_policy_reaches_the_agent(tmp_path, overrides, expected):
    """The manifest drives buzz-agent's real knobs — no window arithmetic."""
    manifest = write_manifest(tmp_path)
    agent_class = manifest.roster[0]
    agent_class = agent_class.model_copy(
        update={
            "generation": agent_class.generation.model_copy(
                update={"context_window_tokens": 1_000_000, **overrides}
            )
        }
    )
    orch = credential("orch-1", "orchestrator", "orch-model")
    environment = Environment(
        responses={"buzz-acp": ExecResult(stdout="4242\n", stderr="", return_code=0)}
    )
    await runtime(tmp_path)._launch_agent(
        environment=environment,
        trial=trial_handle((orch,)),
        credential=orch,
        agent_class=agent_class,
        trial_dir=tmp_path,
    )
    _, env = environment.commands[-1]
    # The real window is always reported honestly, never bent to move the trigger.
    assert env["BUZZ_AGENT_MAX_CONTEXT_TOKENS"] == "1000000"
    for key in ("BUZZ_AGENT_HANDOFF_PERCENT", "BUZZ_AGENT_HANDOFF_AT_TOKENS"):
        assert env.get(key) == expected.get(key)


async def test_thinking_effort_is_pinned_for_every_agent(tmp_path):
    """An unset effort is the provider's default: unrecorded and not portable.

    Every condition claims the same reasoning effort, so the variable has to be
    present in the container env rather than left to each endpoint's default.
    """
    manifest = write_manifest(tmp_path)
    environment = Environment(
        responses={"buzz-acp": ExecResult(stdout="4242\n", stderr="", return_code=0)}
    )
    orch = credential("orch-1", "orchestrator", "orch-model")
    await runtime(tmp_path)._launch_agent(
        environment=environment,
        trial=trial_handle((orch,)),
        credential=orch,
        agent_class=manifest.roster[0],
        trial_dir=tmp_path,
    )
    _, env = environment.commands[-1]
    assert env["BUZZ_AGENT_THINKING_EFFORT"] == "medium"


@pytest.mark.parametrize(
    ("include", "expected"),
    [(True, None), (False, "1")],
)
async def test_platform_prompt_can_be_switched_off_per_condition(
    tmp_path, include, expected
):
    """The [Base] section is ~12KB of prompt the condition did not write.

    It is buzz-acp's production-workspace guidance, prepended ahead of the
    pinned persona, and much of it is wrong inside a graded container. Leaving
    it on is the honest default, but the sensitivity run that turns it off is
    the only thing that shows how much of a result it accounts for — so the
    switch has to reach the container, and its absence has to be real absence
    rather than a "0" buzz-acp would read as set.
    """
    manifest = write_manifest(tmp_path, include_platform_prompt=include)
    environment = Environment(
        responses={"buzz-acp": ExecResult(stdout="4242\n", stderr="", return_code=0)}
    )
    orch = credential("orch-1", "orchestrator", "orch-model")
    await runtime(tmp_path)._launch_agent(
        environment=environment,
        trial=trial_handle((orch,)),
        credential=orch,
        agent_class=manifest.roster[0],
        trial_dir=tmp_path,
    )
    _, env = environment.commands[-1]
    assert env.get("BUZZ_ACP_NO_BASE_PROMPT") == expected


def test_team_table_shows_the_manifest_role_not_the_kind(tmp_path):
    """A lead must be able to tell its implementer from its verifier.

    Both are `kind: worker`, so a table rendered from the kind would list two
    identical rows — and every persona addresses teammates by the job in that
    column. Falls back to the kind so a pre-v1.3 provisioner still composes.
    """
    solo = credential("solo-1", "orchestrator", "m")
    impl = credential("impl-1", "worker", "m", manifest_role="implementer")
    critic = credential("critic-1", "worker", "m", manifest_role="critic")
    bare = credential("bare-1", "worker", "m")
    prompt = tmp_path / "persona.md"
    prompt.write_text("persona\n", encoding="utf-8")
    composed = (
        runtime(tmp_path)
        ._compose_system_prompt(
            trial_dir=tmp_path,
            trial=trial_handle((solo, impl, critic, bare)),
            credential=solo,
            persona_path=prompt,
        )
        .read_text(encoding="utf-8")
    )
    assert "| impl-1 | implementer |" in composed
    assert "| critic-1 | critic |" in composed
    assert "| bare-1 | worker |" in composed
