# Blocks Gate C: live conversation proof

`scripts/prove-blocks.sh` prepares the isolated Blocks environment and is the
only supported launcher for the live proof. It uses the dedicated tuple:

| Service | Address |
| --- | --- |
| Relay HTTP | `http://localhost:3030` |
| Relay WebSocket | `ws://localhost:3030` |
| Postgres | `localhost:5471` |
| Redis | `localhost:6471` |

The harness builds the real `buzz-relay`, `buzz`, and `buzz-acp` binaries; it
does not substitute an in-memory relay or mock CLI. It resets only the
`buzz-harness` Docker Compose project via the existing isolated relay launcher.

## Port overrides

Every port resolves from the `BUZZ_HARNESS_*_PORT` overrides (single source of
truth: `scripts/harness-ports.sh`). Defaults are the fixed tuple above, so a
plain run behaves exactly as before:

| Env var | Default |
| --- | --- |
| `BUZZ_HARNESS_RELAY_PORT` | `3030` |
| `BUZZ_HARNESS_PG_PORT` | `5471` |
| `BUZZ_HARNESS_REDIS_PORT` | `6471` |
| `BUZZ_HARNESS_MINIO_PORT` | `9471` (console is `+1`) |
| `BUZZ_HARNESS_HEALTH_PORT` | `8088` |
| `BUZZ_HARNESS_METRICS_PORT` | `9202` |

To run a second harness concurrently on a disjoint set, export a shifted set
and re-run — the Compose project name follows the relay port
(`buzz-harness` for :3030, otherwise `buzz-harness-<relay-port>`), so
containers, volumes, and the database stay separate automatically. tmux
sessions and log files are port-scoped too (`blocks-relay-<relay-port>`,
`blocks-acp-<relay-port>`).

```bash
export BUZZ_HARNESS_RELAY_PORT=3040  BUZZ_HARNESS_PG_PORT=5481
export BUZZ_HARNESS_REDIS_PORT=6481  BUZZ_HARNESS_MINIO_PORT=9481
export BUZZ_HARNESS_HEALTH_PORT=8098 BUZZ_HARNESS_METRICS_PORT=9212
./scripts/prove-blocks.sh
```

The launcher refuses to start (before touching the Compose stack, the schema,
or the seed) when any port of the set is already owned by another process, and
prints the override commands above.

## Run

From the repository root:

```bash
./scripts/prove-blocks.sh
```

The launcher fails before touching the isolated stack if Hermit cannot be
activated or if Docker, tmux, curl, Node, pnpm, or Cargo are unavailable. It
also runs the native proposal gate:

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml agent_proposal
```

It configures the relay with a deterministic signing key and verifies NIP-11
`self` after startup. This matters: a relay that merely listens on :3030
but starts with an ephemeral identity is not a valid Blocks proof.

When the live spec exists, the launcher executes it. Otherwise it prints the
exact command it expects:

```bash
cd desktop
pnpm exec playwright test tests/e2e/blocks-live.spec.ts --project=integration
```

## Desktop live-spec contract

The launcher exports exactly these variables to the Playwright process:

```text
BUZZ_E2E_BLOCKS_LIVE=1
BUZZ_E2E_RELAY_HTTP_URL=http://localhost:3030
BUZZ_E2E_RELAY_WS_URL=ws://localhost:3030
BUZZ_E2E_RELAY_BIN=<repo>/target/ci/buzz-relay
BUZZ_E2E_CLI_BIN=<repo>/target/ci/buzz
BUZZ_E2E_ACP_BIN=<repo>/target/ci/buzz-acp
BUZZ_E2E_DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz
BUZZ_E2E_HARNESS_PROJECT=buzz-harness
BUZZ_E2E_EVIDENCE_DIR=<repo>/desktop/test-results/blocks/gate-c
BUZZ_E2E_AGENT_AUTH_TAG=<deterministic test-only NIP-OA tag>
BUZZ_E2E_APPROVAL_COUNTER=<evidence-dir>/approval-counter.json
```

`CARGO_PROFILE=debug` or `CARGO_PROFILE=dev` changes the binary directory to
`target/debug`; the other values stay fixed. The test must opt in through
`BUZZ_E2E_BLOCKS_LIVE=1`; it must not silently run against a developer's
default relay.

## ACP and evidence

The launcher starts the checked-in deterministic ACP fixture
`desktop/tests/e2e/fixtures/fake-acp-agent.mjs` under its own tmux session. Its
prompt transcript is written to `acp-prompts.log` inside the evidence directory.
The fixture executes the Approval action through the real ACP path and records
the idempotency key in `approval-counter.json`; the live spec requires the
counter and durable relay claim to both equal one.

Chromium reaches the real relay and uses the real CLI/ACP binaries. The one
intentional seam is Tauri's `execute_agent_proposal` command: browser mode
returns a deterministic safe outcome, while the launcher separately runs the
native Rust recovery/concurrency tests. A passing browser frame therefore
proves the persisted proposal, signed action/receipt, Inbox, and dialog flow; it
does not falsely claim that Chromium spawned a native process.

The relay-mode E2E bridge mirrors native channel membership fields and the
relay's durable `mentions`/`needs_action` feed projection. Resolved proposals
remain visible under **All** as conversation history but disappear from
**Needs action** only after an authoritative resolving receipt.

Relay and ACP logs remain running and visible after the command exits:

```bash
tmux attach -t blocks-relay-3030
tmux attach -t blocks-acp-3030
```

(The suffix is the relay port — `blocks-relay-<port>` / `blocks-acp-<port>`
when `BUZZ_HARNESS_RELAY_PORT` is overridden.)

The expected evidence directory is
`desktop/test-results/blocks/gate-c/`. Preserve it with the relay/ACP logs,
CLI JSON outputs, database assertions, and screenshots from the live spec.
`git-revision.txt` records the exact checked-out commit and `git-status.txt`
records whether that proof was run from a dirty tree. Release evidence must
name a clean final commit.

To stop only the processes launched for this gate:

```bash
tmux kill-session -t blocks-acp-3030
tmux kill-session -t blocks-relay-3030
```

## CI

`.github/workflows/ci.yml` runs this gate as the `blocks-live-gate` job on
GitHub-hosted `ubuntu-latest` (free on this public repository). It is
path-filtered to the Blocks surface — the relay/core validators, the desktop
`features/blocks` code and kind constants, the live spec and ACP fixture, the
Blocks migrations, and the two harness scripts — plus every push to
`develop`, following the same path-filter pattern as the rest of the suite.
The job installs tmux and runs `scripts/prove-blocks.sh` unchanged, so CI and
the local gate prove exactly the same loop. Gate evidence is uploaded as the
`blocks-live-gate-artifacts` artifact (`desktop/test-results/blocks`, relay
and ACP logs).

To tear down the isolated backing services as well (this removes their isolated
database volume):

```bash
docker compose -p buzz-harness -f docker-compose.harness.yml down -v
```

With overridden ports, use the derived project name instead:
`docker compose -p buzz-harness-<relay-port> -f docker-compose.harness.yml down -v`.
