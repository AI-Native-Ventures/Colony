# Testing

## Automated Tests

```bash
just test-unit          # unit tests — no infrastructure needed
just test               # unit + integration (starts Docker if needed)
```

`just test` runs unit tests plus integration tests against Postgres and Redis
(started automatically if not already running). Neither task runs the E2E suites in
`buzz-test-client` — those are marked `#[ignore]` and require a running relay:

```bash
# Start a relay first (see below), then:
cargo test -p buzz-test-client -- --ignored
```

### Colony company work (`e2e_company_work`)

This suite proves the rules that only exist inside the relay process: that
Company, Initiative, and Task heads are authored by the relay and by nobody
else, that only the community owner can ask for one, and that compare-and-set,
illegal transitions, and replays all reach deterministic receipts. It also runs
the activation ladder `buzz-sdk::initiative_activation` produces against the
real broker, which is the one thing unit tests over that function cannot
establish.

It needs its own relay, because the community owner is fixed at startup:

```bash
# 1. A database of its own, so a failed run never leaves state behind in yours.
docker exec buzz-postgres psql -U buzz -d postgres -c "CREATE DATABASE buzz_company_proof;"

# 2. The owner key the suite signs as. Print it rather than copying it:
cargo test -p buzz-test-client --test e2e_company_work \
  print_the_owner_pubkey -- --nocapture

# 3. A relay that treats that key as the community owner.
DATABASE_URL="postgres://buzz:buzz_dev@localhost:5432/buzz_company_proof" \
REDIS_URL="redis://localhost:6379" \
BUZZ_BIND_ADDR="127.0.0.1:3099" \
RELAY_URL="http://127.0.0.1:3099" \
BUZZ_AUTO_MIGRATE=true \
BUZZ_RELAY_PRIVATE_KEY="<any 64-hex secret>" \
RELAY_OWNER_PUBKEY="<the key printed above>" \
cargo run -p buzz-relay

# Already running your own relay? Add BUZZ_METRICS_PORT and BUZZ_HEALTH_PORT
# to avoid colliding with it.
```

`BUZZ_AUTO_MIGRATE=true` is required on a fresh database and its absence is
quiet: the relay logs one INFO line, serves NIP-11 happily, and then every
write fails with `relation "events" does not exist`. `BUZZ_RELAY_PRIVATE_KEY`
is what makes the relay advertise a `self` key, without which the suites cannot
resolve the head author and prove nothing.

```bash

# 4. The suite.
RELAY_URL=ws://localhost:3099 RELAY_HTTP_URL=http://localhost:3099 \
cargo test -p buzz-test-client --test e2e_company_work -- --ignored --test-threads=1
```

`--test-threads=1` is not optional: every test in the file signs as the same
owner, and the relay serializes company actions per owner.

The suite also proves the attributed turn metric survives a real round trip:
the agent registers itself as owned through NIP-OA, encrypts a `kind:44200` to
the owner, and the owner reads it back and decrypts it. The relay stores a blob
it cannot read, which the test asserts on directly, because a metric whose work
context were legible to whoever runs the relay would expose the company's cost
structure.

### Live agent attribution (manual)

The suite proves the metric contract. Proving that a *live harness* charges a
real turn to real work needs a real model, so it is a runbook rather than a
test:

```bash
# Seed the company, team, initiative, and Task the run charges against.
RELAY_URL=ws://localhost:3099 RELAY_HTTP_URL=http://localhost:3099 \
cargo test -p buzz-test-client --test e2e_company_work \
  seed_live_work_context -- --ignored --nocapture

# Print the agent identity and the owner-signed auth tag the relay requires.
cargo test -p buzz-test-client --test e2e_company_work \
  print_live_agent_credentials -- --ignored --nocapture

# Create a channel as the owner, have the agent join it, start buzz-acp with
# that identity, then send it work-tagged instructions:
buzz messages send --channel <uuid> --content "..." --mention <agent pubkey> \
  --task livecompany:live-task \
  --initiative livecompany:live-initiative \
  --team live-team

# Read back every metric addressed to the owner and print its work context.
RELAY_URL=ws://localhost:3099 RELAY_HTTP_URL=http://localhost:3099 \
cargo test -p buzz-test-client --test e2e_company_work \
  inspect_live_turn_metrics -- --ignored --nocapture
```

**Known gap, verified 2026-08-02:** neither `opencode acp` nor `goose acp`
reports token usage over ACP on this machine, and `publish_agent_turn_metric`
is a no-op without usage. Three live turns produced a correct agent reply and
zero `kind:44200` events. So this runbook proves the turn runs and carries its
work references, but the NIP-AM metric half cannot be observed until a harness
that reports usage is available. That is pre-existing behaviour of the
adapters, not of the attribution path.

**Superseded for accounting purposes (NIP-CL, 2026-08-02).** That gap is why
the cost ledger does not depend on an agent reporting its own usage at all.
Token counts are captured at the provider wire by the metering checkpoint, so
a harness that reports nothing is still fully metered. See the live proof
below; NIP-AM remains useful as a cross-check but is no longer the source of
record.

### Cost ledger live provider proof (`buzz-meter`)

The one test in this repo that spends real money. Every other metering test
feeds the parsers a fixture, which proves the parser matches a response *we*
wrote. This proves it matches a response a real provider actually sent.

```bash
BUZZ_METER_LIVE_KEY=<real provider key> \
BUZZ_METER_LIVE_UPSTREAM=https://api.deepseek.com \
BUZZ_METER_LIVE_MODEL=deepseek-chat \
cargo test -p buzz-meter --test live_provider -- --ignored --nocapture
```

Works against any OpenAI-compatible provider; set `BUZZ_METER_LIVE_UPSTREAM`
and `BUZZ_METER_LIVE_MODEL` to match the key. Costs a fraction of a cent.

**Result, 2026-08-02, DeepSeek:** the agent authenticated with a
`colony-vk-` virtual key, the real credential never left the checkpoint, and
the recorded call carried the provider's own itemization (10 uncached input
tokens, 2 output tokens) under `provider: "deepseek"`.

Two defects were found by running it rather than by reasoning about it:

1. The record originally said `provider: "openai"`, because DeepSeek is
   reached through the OpenAI-compatible route. Reconciliation compares per
   provider, so that spend would have been checked against an OpenAI invoice
   that never contained it. The slug is now derived from the upstream host.
2. That derivation then produced `"0"` for a `127.0.0.1` test upstream. An
   address is not a vendor, so IP-literal and `localhost` upstreams now fall
   back to the route's own slug.

Starting the relay with any other `RELAY_OWNER_PUBKEY` makes the suite prove
nothing — every action is refused for the right reason and the failures look
like product bugs. If the whole file fails at the first company create, check
that first.

### Codex metering live proof (`buzz-acp`)

Codex is the one managed runtime that ignores the `OPENAI_BASE_URL`-style
variables the meter overwrites — it routes model traffic through its own
provider config. The harness meters it differently: after `initialize`, it
sends the ACP `providers/set` call configuring the codex-acp adapter's
custom-gateway provider with the checkpoint URL and the agent's virtual key.
The adapter forces that provider onto every session and skips the ChatGPT
login gate, so a metered codex needs no OpenAI account on the machine.

This test runs a real codex binary and the real adapter through the real
checkpoint. Spends nothing: the checkpoint's upstream is a local sink that
answers a fixed Responses-API stream.

```bash
npm pack @agentclientprotocol/codex-acp && tar xzf agentclientprotocol-codex-acp-*.tgz
BUZZ_CODEX_ACP_JS=$PWD/package/dist/index.js \
CODEX_PATH="$(which codex)" \
cargo test -p buzz-acp --lib live_codex_turn_is_metered -- --ignored --nocapture
```

**Result, 2026-08-03, codex 0.146.0 + codex-acp 1.1.9:** every codex request
crossed the checkpoint's loopback gateway, the upstream saw only the
checkpoint's real credential, and the recorded call carried the stream's own
itemization (35 uncached input, 7 cached, 3 output) attributed to the
agent's virtual-key label.

A metered codex whose adapter does not advertise the providers API
(codex-acp < 1.1) **fails to start**, with an error naming the upgrade. That
is deliberate: skipping the gateway call would let the agent spend real
money invisibly, which is the gap this closes. `--no-meter` remains the
explicit opt-out. The desktop's adapter floor (`MIN_CODEX_ACP_VERSION`,
1.1.7) already includes `providers/set`.

### Colony cost ledger (`e2e_cost_ledger`)

Proves what only exists inside a relay process: that book heads are authored
by the relay and nobody else, that only the human owner can append a price or
a correction, that a republished usage record is counted once while two
providers issuing the same request id stay distinct, that an unpriced model is
flagged and becomes countable when the price arrives without republishing
anything, that a correction re-attributes a record without rewriting it, and
that spend history is unreadable by another member.

> **Run against a disposable relay and database only.** Unlike the party
> suite, this one cannot isolate itself. A party test scopes to a generated
> company and handle prefix; the price book, rulebook, and correction book are
> single coordinates per community and append-only by design, so every test
> price lands in the same book a real company would use and there is no delete.
> Never point this at a shared or deployed relay.

```bash
docker exec buzz-postgres psql -U buzz -d postgres \
  -c "DROP DATABASE IF EXISTS colony_ledger_e2e WITH (FORCE);" \
  -c "CREATE DATABASE colony_ledger_e2e OWNER buzz;"

DATABASE_URL="postgres://buzz:buzz_dev@localhost:5432/colony_ledger_e2e" \
REDIS_URL="redis://localhost:6379" \
BUZZ_BIND_ADDR="127.0.0.1:3099" \
RELAY_URL="http://localhost:3099" \
BUZZ_AUTO_MIGRATE=true \
BUZZ_RELAY_PRIVATE_KEY="<any 64-hex secret>" \
RELAY_OWNER_PUBKEY="<printed by e2e_company_work print_the_owner_pubkey>" \
BUZZ_METRICS_PORT=9899 BUZZ_HEALTH_PORT=8899 \
cargo run -p buzz-relay

RELAY_URL=ws://localhost:3099 RELAY_HTTP_URL=http://localhost:3099 \
cargo test -p buzz-test-client --test e2e_cost_ledger -- --ignored --test-threads=1
```

`RELAY_URL` on the relay must name the same host the tests connect to. The
community is seeded for the host derived from that URL, so starting with
`http://127.0.0.1:3099` while the tests dial `ws://localhost:3099` produces
`relay: no community is configured for this host` on every test.

`--test-threads=1` is not optional: the books are singleton coordinates, so
concurrent appends race each other's compare-and-set.

**Two defects this gate found, 2026-08-02**, neither visible to unit tests:

1. Two appends inside the same second collided. NIP-33 keeps the newest event
   at a coordinate, so a replacement that is not strictly newer is discarded,
   and the second price entry was refused with "lost NIP-33 replacement
   ordering". For a price book that means a published price silently failing to
   take effect. Heads now step past the stored head when the clock has not.
2. A non-owner's action was answered with whichever validation failed first
   rather than with the refusal it was, and their event was stored on the way.
   The broker's own contract said "not the owner" means refuse without storing;
   only the transaction-internal check enforced it. Authority is now checked
   first, cheaply, with the authoritative `FOR UPDATE` check still inside the
   commit where it is safe against concurrent ownership transfer.

Defect 2 only appears on a **second** run against the same database, because
the first run creates the books. Run the suite twice before believing it.

### Colony party identity (`e2e_party_identity`)

A Party is one real-world business or person; Lead and Client are views over
that identity rather than separate records. This suite proves the parts of that
which only exist inside the relay process: that party, alias, and relationship
heads are authored by the relay and by nobody else, that a merge writes the
survivor, the retired handle's pointer, and every re-pointed view in one
transaction, and that a merge the relay cannot decide safely is refused with a
signed receipt instead of resolved.

The load-bearing assertion is that a retired handle still arrives. A handle
written into a task, a message, or an agent's work context months ago has to
keep resolving to whichever party absorbed it, and no unit test over a mock can
establish that the stored alias does so.

Uses the same relay setup as `e2e_company_work` above — same owner key, same
`RELAY_OWNER_PUBKEY` requirement, same reason:

```bash
RELAY_URL=ws://localhost:3099 RELAY_HTTP_URL=http://localhost:3099 \
cargo test -p buzz-test-client --test e2e_party_identity -- --ignored --test-threads=1
```

`--test-threads=1` is not optional: every test signs as the same owner, and the
relay serializes party actions per owner.

Each test isolates itself with a generated company and handle prefix, so a
failed run leaves records behind but never collides with the next one.

**Start a fresh relay process for each full run.** Running either E2E suite
repeatedly against one long-lived relay produces intermittent read and publish
timeouts that have nothing to do with the records under test: a subscription
never receives its EOSE, or a published event never receives its OK, while the
same test passes alone and in pairs against the same relay and the same data.
Verified 2026-08-02 by running `e2e_company_work` against the same process,
which fails the same way, so this is in the shared WebSocket harness rather
than in anything company- or party-specific. It is not diagnosed. `head` in
`e2e_party_identity` retries a timed-out read once, which is enough for a
single run on a fresh relay but does not make repeat runs reliable.

---

## Live Local Relay

The fastest way to exercise the relay end-to-end is to build the release
binaries once, run `buzz-relay`, and drive it with the `buzz` CLI. The
CLI signs every request with NIP-98, so you don't need `nak` or hand-rolled
`curl`.

### 1. Setup

```bash
. ./bin/activate-hermit          # activate pinned toolchain
cp .env.example .env             # one-time
just setup                       # start Docker services, run migrations
```

> **Already running Buzz Desktop?** Desktop uses the same Docker container
> names (`buzz-postgres`, `buzz-redis`) and the same
> default ports (`:5432`, `:6379`). `just setup` will reuse those
> services, so **your test relay writes into Desktop's database**. That's
> fine for read/write smoke tests, but: `just reset` wipes Desktop's data
> along with yours. If you need isolation, stop Desktop first or run the
> dev stack on a different Compose project
> (`COMPOSE_PROJECT_NAME=buzz-dev docker compose …`).

`just reset` wipes all local data and starts over — **including Buzz
Desktop's data** if its services are sharing your dev stack (see callout
above).

> **Heads up — scrub stale env first.** If your shell inherits any of
> `BUZZ_AUTH_TAG`, `BUZZ_RELAY_URL`, or `BUZZ_PRIVATE_KEY` from a
> prior session (or a staging config), `unset` them before continuing.
> A stale `BUZZ_AUTH_TAG` fails the **local dev relay** with
> `auth_error: signature verification failed` on the first CLI write —
> it is *not* tolerated.
> ```bash
> unset BUZZ_AUTH_TAG BUZZ_RELAY_URL BUZZ_PRIVATE_KEY
> ```

### 2. Build the binaries

```bash
cargo build --release -p buzz-relay -p buzz-cli -p buzz-admin
export PATH="$PWD/target/release:$PATH"
```

Rebuild after any code change — the steps below use the release binaries.

### 3. Start the relay

In a separate terminal (it runs in the foreground):

```bash
buzz-relay                     # release binary from step 2, serves ws://localhost:3000
# alternatives:
# cargo run --release -p buzz-relay     # rebuild + run in release
# just relay                            # DEBUG build — fast to launch on a hot cache,
#                                       # but mismatched if step 2 left you on release.
#                                       # Use `just relay-release` if you want the recipe.
```

Verify it's up (back in your working terminal):

```bash
curl -s http://localhost:3000/health           # → ok
curl -s http://localhost:8080/_readiness        # → {"status":"ready"}
```

> Health/readiness/liveness live on a **separate port** (default `8080`,
> `BUZZ_HEALTH_PORT`) so K8s probes bypass auth middleware. The main app
> port also exposes `/health` for convenience.

The relay starts in dev mode (`BUZZ_REQUIRE_AUTH_TOKEN=false`). The startup
log emits a WARN about this — that's expected for local testing. See the env
vars table at the bottom if you need to lock it down.

> **Already running Buzz Desktop (or another relay) on `:3000` / `:8080` /
> `:9102`?** Buzz binds three ports — main, health, metrics — and any of
> them can collide. Use a separate terminal per role and export the right
> vars in each:
>
> **In the relay terminal** (before launching `buzz-relay`):
> ```bash
> export BUZZ_BIND_ADDR=0.0.0.0:3030
> export BUZZ_HEALTH_PORT=8088
> export BUZZ_METRICS_PORT=9202
> export RELAY_URL=ws://localhost:3030     # advertised in NIP-42 challenges
> buzz-relay
> ```
>
> **In your working / CLI terminal** (for steps 4+ and the ACP harness):
> ```bash
> export BUZZ_RELAY_URL=http://localhost:3030    # CLI target
> # verify the relay on the overridden ports:
> curl -s http://localhost:3030/health             # → ok
> curl -s http://localhost:8088/_readiness         # → {"status":"ready"}
> ```
>
> Every snippet later in this doc shows the defaults. When you see
> `localhost:3000` / `:8080` in a code block, mentally substitute your
> overrides — or the CLI will end up talking to Buzz Desktop's relay.

> **Ignore `just setup`'s "Next steps" banner.** It still prints
> `just relay` (a debug build). Use `buzz-relay` from step 2 here —
> step 2 already built the release binary.

When you're done, stop the relay (Ctrl-C in its terminal). If it's
backgrounded or you lost the terminal: `pkill -f buzz-relay`. Leaving
it running will collide with the next reviewer who follows this doc on
the same machine.

### 4. Smoke test the CLI against the relay

End-to-end: generate an identity, create a channel, post a message, read it
back. This is the minimum sequence an agent needs to verify a local relay.

```bash
# Generate a keypair
GEN=$(buzz-admin generate-key)
export BUZZ_PRIVATE_KEY=$(echo "$GEN" | awk '/Secret key:/ {print $3}')
PUBKEY=$(echo "$GEN"           | awk '/Public key:/ {print $3}')
echo "pubkey: $PUBKEY"

# Create a channel — the UUID is returned in the response
CHANNEL=$(buzz channels create --name "smoke-$$" --type stream --visibility open | jq -r '.channel_id')
echo "channel: $CHANNEL"

# Send a message and read it back
SEND=$(buzz messages send --channel "$CHANNEL" --content "hello from smoke test")
EVENT_ID=$(echo "$SEND" | jq -r '.event_id')
buzz messages get --channel "$CHANNEL" --limit 5 | jq .

# Fetch the reply chain for a specific message (empty array on a leaf — that's fine)
buzz messages thread --channel "$CHANNEL" --event "$EVENT_ID" | jq .
```

A successful run prints `{"event_id":"…","accepted":true,"message":""}` for
the send, and the message body in the `get` output. `thread` returns `[]`
for a leaf message — populated only after a reply comes in (see §5).

### 5. Going deeper

For full coverage of every CLI command (54 subcommands across 12 groups),
follow [`crates/buzz-cli/TESTING.md`](crates/buzz-cli/TESTING.md).

The relay's HTTP bridge accepts three endpoints — useful if you're testing
a client other than `buzz-cli`:

| Endpoint        | Purpose                            |
|-----------------|------------------------------------|
| `POST /events`  | Submit a signed Nostr event        |
| `POST /query`   | NIP-01 filter query (returns events) |
| `POST /count`   | NIP-45 count query                 |

All three accept NIP-98 auth (recommended) or, in dev mode, an `X-Pubkey`
header fallback. There is no REST API for fetching message threads — use
`POST /query` with an `#e` filter, or `buzz messages thread`.

---

## ACP Harness (optional, end-to-end with a real agent)

`buzz-acp` connects an ACP-speaking agent (goose, codex, claude code,
buzz-agent) to the relay. The harness listens for events, drives the
agent over stdio, and the agent replies through MCP tools.

Minimum recipe — assumes the relay from step 3 is running and the channel
`$CHANNEL` from step 4 still exists. The agent identity must be **different**
from the sender identity (`BUZZ_ACP_RESPOND_TO=anyone` still skips events
the agent signed itself).

```bash
cargo build --release -p buzz-acp
export PATH="$PWD/target/release:$PATH"

# 1. Save your sender identity from step 4 — you'll need it to @mention the agent
SENDER_SK="$BUZZ_PRIVATE_KEY"

# 2. Mint a fresh agent identity and capture its pubkey
AGENT_GEN=$(buzz-admin generate-key)
AGENT_SK=$(echo "$AGENT_GEN" | awk '/Secret key:/ {print $3}')
AGENT_PUBKEY=$(echo "$AGENT_GEN" | awk '/Public key:/ {print $3}')

# 3. Add the agent as a member of $CHANNEL — still using the sender identity.
#    Skip this and the agent boots to "discovered 0 channel(s) → agent will
#    sit idle" and silently ignores every mention.
buzz channels add-member --channel "$CHANNEL" --pubkey "$AGENT_PUBKEY" --role member

# 4. Switch to the agent identity and start it.
#    buzz-acp wants ws:// (not http://). If you set BUZZ_RELAY_URL to an
#    http:// URL in step 3, set the ws:// equivalent here — same host/port.
export BUZZ_PRIVATE_KEY="$AGENT_SK"
export BUZZ_RELAY_URL=ws://localhost:3000   # match step 3 (e.g. ws://localhost:3030 if overridden)
export BUZZ_ACP_RESPOND_TO=anyone           # default is owner-only; opens the gate for testing
# NIP-AE core-memory prompt injection is on by default; set BUZZ_ACP_NO_MEMORY=true to opt out.
export GOOSE_MODE=auto                        # must be 'auto' or goose hangs on prompts

buzz-acp                                    # foreground; logs to stdout (run in a separate terminal)

# Optional: turn on per-turn tracing if the default log is too quiet.
# RUST_LOG=buzz_acp=debug buzz-acp
```

> **Using a different ACP agent?** The default recipe assumes `goose` is on
> `$PATH` and configured (`goose --version` should print). For codex / claude
> code / buzz-agent, set `BUZZ_ACP_AGENT_COMMAND` and `BUZZ_ACP_AGENT_ARGS`
> accordingly — see `crates/buzz-acp/README.md`. Without these, buzz-acp
> will fail to spawn the agent subprocess on startup.

If you started the agent before adding it to the channel, just run the
`add-member` afterwards — it picks up the membership notification live and
subscribes without restart (`membership notification: subscribing to new channel …`).

The justfile also ships `just goose key="$AGENT_NSEC"` (foreground) and
`just goose-bg key="$AGENT_NSEC"` (background screen session) which set the
same env. See `crates/buzz-acp/README.md` for parallel agents, heartbeats,
respond-to gates, and forum subscriptions.

To exercise deferred ACP startup, add `BUZZ_ACP_LAZY_POOL=true` before launching
`buzz-acp`. The harness should connect, authenticate, subscribe, and publish
online presence without starting the configured ACP child. The first accepted,
flushable mention should start exactly one child and then dispatch the queued
message. Automated coverage in `pool_lifecycle_state` pins single-wake,
retry/backoff, and stale-result behavior; it does not replace this real
relay/process smoke test.

Send the agent a task — switch your shell back to the **sender** identity
from step 4 and @mention the agent:

```bash
export BUZZ_PRIVATE_KEY=$SENDER_SK          # the key from step 4
buzz messages send --channel "$CHANNEL" \
  --content "Hey agent, reply PONG only."

# Wait 10–90s, then read the channel — the agent's reply is a kind:9 from
# AGENT_PUBKEY. The current ACP build is quiet on stdout during a turn, so
# `buzz messages get` is how you confirm it ran.
buzz messages get --channel "$CHANNEL" --limit 5 | jq '.[] | {pubkey, content}'
```

Replies are kind:9 in the same channel; `buzz messages thread --channel <id>
--event <event_id>` fetches the reply chain for a specific mention.

---

## Configuration reference

The relay reads all configuration from environment variables. Defaults work
out of the box with `just setup` or `just relay`. Common overrides:

| Variable                          | Default                     | Notes |
|-----------------------------------|-----------------------------|-------|
| `BUZZ_BIND_ADDR`                | `0.0.0.0:3000`              | Main app port |
| `BUZZ_HEALTH_PORT`              | `8080`                      | `/_liveness`, `/_readiness` |
| `BUZZ_METRICS_PORT`             | `9102`                      | Prometheus `/metrics` |
| `RELAY_URL`                       | `ws://localhost:3000`       | Advertised in NIP-11 / NIP-42 challenges. **Note: no `BUZZ_` prefix.** |
| `DATABASE_URL`                    | `postgres://buzz:buzz_dev@localhost:5432/buzz` | |
| `REDIS_URL`                       | `redis://localhost:6379`    | |
| `BUZZ_REQUIRE_AUTH_TOKEN`       | `false`                     | When true, REST requires NIP-98 (no `X-Pubkey` fallback) |
| `BUZZ_REQUIRE_RELAY_MEMBERSHIP` | `false`                     | When true, only pubkeys in `relay_members` can connect |
| `BUZZ_REQUIRE_MEDIA_GET_AUTH`   | `false`                     | When true, `GET`/`HEAD /media/*` require Blossom kind 24242 `t=get` auth plus relay membership. |
| `BUZZ_AUDIT_ENABLED`            | `true`                      | Tamper-evident event/media audit log. Set `false`/`0`/`off` to skip its DB pool and writes. Does not disable the separate moderation audit trail. |
| `BUZZ_AUTO_MIGRATE`             | `false`                     | Opt in with `true`/`1`/`yes`/`on` to run embedded SQLx migrations on relay startup |
| `RELAY_OWNER_PUBKEY`              | unset                       | Bootstrapped as `owner` in `relay_members` at first start |
| `BUZZ_ALLOW_NIP_OA_AUTH`        | `false`                     | Enable NIP-OA owner attestation for membership |
| `BUZZ_WEB_DIR`                  | unset (source), `/srv/buzz/web` (container) | Directory containing the invite landing bundle; the production container enables it so `/invite/{code}` always works |
| `BUZZ_SERVE_GIT_WEB_GUI`        | `false`                     | Set to `true` or `1` to expose the bundled Git repository browser at `/` and `/repos/...`; invite routes do not depend on this flag |

CLI-side, only two matter for testing:

| Variable                | Default                  | Notes |
|-------------------------|--------------------------|-------|
| `BUZZ_RELAY_URL`      | `http://localhost:3000`  | CLI relay base; accepts `ws(s)://` and normalises |
| `BUZZ_PRIVATE_KEY`    | — (**required**)         | `nsec1…` or 64-char hex |
| `BUZZ_AUTH_TAG`       | unset                    | Optional NIP-OA owner attestation JSON |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `relay error 500` or `400: restricted: not a channel member` after a code change | Stale binary | Rebuild and re-export `PATH`; or `cargo run` directly |
| `Address already in use` on relay start (os error 48 on macOS, 98 on Linux) | Another relay (or stale process) holding `:3000` / `:8080` / `:9102` (or your override ports) | The panic line names the failing port — read it first. Then `lsof -iTCP:3000,8080,9102 -sTCP:LISTEN` (or your override equivalents). Kill the offender (`pkill -f buzz-relay`) or use the port-override block in step 3. If you already overrode and *still* collide, a prior reviewer left a relay running on the same alt ports — kill it or pick fresh ports |
| `auth_error: BUZZ_PRIVATE_KEY is required` | Env not exported into the CLI's shell | `export BUZZ_PRIVATE_KEY=...` (or pass `--private-key`) |
| `auth_error: BUZZ_AUTH_TAG verification failed … signature verification failed` | A stale `BUZZ_AUTH_TAG` inherited from a parent shell. The local dev relay rejects it. | `unset BUZZ_AUTH_TAG` (see the scrub block in step 1) |
| `auth-required: verification failed` on a closed relay | NIP-OA attestation needed | Set `BUZZ_AUTH_TAG` to the owner-issued JSON, or relax `BUZZ_REQUIRE_RELAY_MEMBERSHIP` |
| `channels list` empty after `channels create` | The CLI doesn't echo the channel UUID; use the filter shown in step 4 | Or `POST /query` with `{"kinds":[39002]}` |
| ACP agent ignores all events | `BUZZ_ACP_RESPOND_TO=owner-only` (default) with no owner configured | Set `BUZZ_ACP_RESPOND_TO=anyone` for testing |
| ACP logs `discovered 0 channel(s)` / `no channel subscriptions resolved` | Agent identity isn't a member of any channel | `buzz channels add-member --channel "$CHANNEL" --pubkey "$AGENT_PUBKEY" --role member` from another identity |
| `GOOSE_MODE` warning, agent hangs | Not set | `export GOOSE_MODE=auto` |
| Tests pass locally but CI fails | Forgot to run `just ci` | `just ci` runs the gate (fmt, clippy, unit tests, desktop/web builds) |
