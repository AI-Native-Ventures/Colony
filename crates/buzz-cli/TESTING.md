# buzz-cli Live Testing Guide

Manual testing runbook for verifying every CLI command against a local relay.
An agent or developer follows this step by step, running each command and
checking the output.

---

## 1. Prerequisites

Docker services running and healthy:

```bash
docker compose ps
# buzz-postgres   healthy
# buzz-redis      healthy
```

If not running: `just setup` from the repo root.

Tools: `jq`, `curl`, Rust toolchain.

---

## 2. Build the CLI

```bash
cargo build -p buzz-cli
```

Use `cargo run -p buzz-cli --` or the built binary at `target/debug/buzz`.

---

## 3. Start the Relay

In a separate terminal:

```bash
cd REPOS/buzz-nostr
set -a && source .env && set +a
cargo run -p buzz-relay
```

Verify:

```bash
curl -s http://localhost:3000/_liveness
# "ok" or 200 status
```

The `.env` should have `BUZZ_REQUIRE_AUTH_TOKEN=false` for local dev.

---

## 4. Mint Test Credentials

### Option A: buzz-admin (full scopes including admin)

This mints a token with all CLI-relevant scopes (including `admin:channels`)
via direct DB access. Use this for testing admin operations (archive,
delete-channel, add/remove-channel-member).

```bash
cargo run -p buzz-admin -- generate-key
```

This prints a public/secret keypair. Save the secret for `BUZZ_PRIVATE_KEY`.

To make that identity a relay **member** or **admin**:

```bash
DATABASE_URL="${DATABASE_URL:?set DATABASE_URL for the local Buzz database}" \
cargo run -p buzz-admin -- add-member --pubkey <hex-or-npub> --role admin
```

`add-member` deliberately refuses `--role owner`. The community owner is set
by `RELAY_OWNER_PUBKEY` on the relay process and bootstrapped at startup — the
owner is deployment configuration, not something an admin command can grant.
This matters for company commands, which require the owner specifically.

Export:

```bash
export BUZZ_RELAY_URL="http://localhost:3000"
export BUZZ_PRIVATE_KEY="nsec1..."   # from the mint output
```

### Scope reference

| Scope | Self-mintable | Needed for |
|-------|:---:|------------|
| `messages:read` | ✅ | `messages get`, `messages thread`, `messages search`, `feed get` |
| `messages:write` | ✅ | `messages send`, `messages edit`, `messages delete`, `reactions`, `messages vote` |
| `channels:read` | ✅ | `channels list`, `channels get`, `channels members` |
| `channels:write` | ✅ | `channels create`, `channels update`, `channels join`, `channels leave`, `channels topic`, `channels purpose` |
| `users:read` | ✅ | `users get`, `users presence` |
| `users:write` | ✅ | `users set-profile`, `users set-presence`, `users set-status` |
| `files:read` | ✅ | — |
| `files:write` | ✅ | — |
| `admin:channels` | ❌ | `channels archive`, `channels unarchive`, `channels delete`, `channels add-member`, `channels remove-member` |

---

## 5. Unit Tests

```bash
cargo test -p buzz-cli
# Expected: see cargo test -p buzz-cli for current count

cargo clippy -p buzz-cli -- -D warnings
# Expected: zero warnings
```

---

## 6. Live Testing — Command by Command

Run each command, verify exit code 0 and check output. Most commands
return JSON (pipe through `jq .` to validate). Commands are ordered so
earlier ones create resources that later ones need.

### 6.1 Channels

```bash
# channels create (stream)
buzz channels create --name "test-stream" --type stream --visibility open \
  --description "CLI test channel" | jq .
# Save the channel ID:
CHANNEL_ID=$(buzz channels create --name "test-cli" --type stream --visibility open | jq -r '.channel_id')
# Expected: {"event_id":"...","accepted":true,"message":"...","channel_id":"<uuid>"}

# channels create (forum) — needed for messages vote later
FORUM_ID=$(buzz channels create --name "test-forum" --type forum --visibility open | jq -r '.channel_id')

# channels list
buzz channels list | jq .
# Expected: [{"channel_id":"...","name":"...","description":"...","created_at":N}]
buzz channels list --visibility open | jq .
buzz channels list --member | jq .

# channels get
buzz channels get --channel "$CHANNEL_ID" | jq .
# Expected: {"channel_id":"...","name":"...","description":"...","created_at":N,"pubkey":"..."} or null

# channels update
buzz channels update --channel "$CHANNEL_ID" --name "test-cli-updated" \
  --description "Updated" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"..."}

# channels topic
buzz channels topic --channel "$CHANNEL_ID" --topic "Test topic" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"..."}

# channels purpose
buzz channels purpose --channel "$CHANNEL_ID" --purpose "Testing" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"..."}

# channels join (may already be a member from create)
buzz channels join --channel "$CHANNEL_ID" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"..."}

# channels leave
# NOTE: Fails with 400 "cannot remove the last owner" if this identity is the
# sole owner (which it is after channels create). To test leave successfully,
# first add-member a second pubkey as owner. The relay enforces ≥1 owner.
buzz channels leave --channel "$CHANNEL_ID" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"..."} (or 400 if last owner)

# Re-join so we can send messages
buzz channels join --channel "$CHANNEL_ID" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"..."}

# channels archive (requires admin:channels scope)
buzz channels archive --channel "$CHANNEL_ID" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"..."}

# channels unarchive
buzz channels unarchive --channel "$CHANNEL_ID" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"..."}
```

### 6.2 Canvas

```bash
# canvas set
buzz canvas set --channel "$CHANNEL_ID" --content "# Test Canvas" | jq .

# canvas set from stdin
echo "# Canvas from stdin" | buzz canvas set --channel "$CHANNEL_ID" --content - | jq .

# canvas get
buzz canvas get --channel "$CHANNEL_ID"
# Expected: raw markdown string, or: null

# Thread-scoped canvas: post a thread root, then write its canvas
ROOT_ID=$(buzz messages send --channel "$CHANNEL_ID" --content "thread root for canvas test" | jq -r '.event_id')

# canvas set --thread (thread working memory)
buzz canvas set --channel "$CHANNEL_ID" --thread "$ROOT_ID" --content "Thread A memory" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"..."}

# canvas get --thread round-trips that thread's content
buzz canvas get --channel "$CHANNEL_ID" --thread "$ROOT_ID"
# Expected: Thread A memory

# Omitting --thread reads the channel canvas — must NOT return the thread's
buzz canvas get --channel "$CHANNEL_ID"
# Expected: # Test Canvas (or the last channel-canvas set), never "Thread A memory"

# Two threads in one channel hold independent canvases
ROOT2_ID=$(buzz messages send --channel "$CHANNEL_ID" --content "second thread root" | jq -r '.event_id')
buzz canvas set --channel "$CHANNEL_ID" --thread "$ROOT2_ID" --content "Thread B memory" | jq .
buzz canvas get --channel "$CHANNEL_ID" --thread "$ROOT_ID"
# Expected: Thread A memory (unchanged by the Thread B write)
buzz canvas get --channel "$CHANNEL_ID" --thread "$ROOT2_ID"
# Expected: Thread B memory

# Over-cap writes surface the relay's rejection message naming cap and size
python3 -c "print('z'*5000)" | buzz canvas set --channel "$CHANNEL_ID" --thread "$ROOT_ID" --content -
# Expected: rejected; message contains "exceeds maximum size of 4096 bytes (got 5000)"
# Exit code: 2 (network/relay rejection)
```


### 6.3 Messages

```bash
# messages send
MSG=$(buzz messages send --channel "$CHANNEL_ID" --content "Hello from CLI test" | jq .)
echo "$MSG"
EVENT_ID=$(echo "$MSG" | jq -r '.event_id')

# messages send with reply + broadcast
REPLY=$(buzz messages send --channel "$CHANNEL_ID" --content "Reply" \
  --reply-to "$EVENT_ID" --broadcast | jq .)
echo "$REPLY"
REPLY_ID=$(echo "$REPLY" | jq -r '.event_id')

# messages send with mentions — @name in content is auto-resolved, no flag needed
buzz messages send --channel "$CHANNEL_ID" --content "Hey @someone" | jq .

# messages send with NIP-27 nostr:npub1… inline mention — auto-resolved to p-tag
buzz messages send --channel "$CHANNEL_ID" \
  --content "Check with nostr:npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg on this" | jq .

# messages send from stdin — safe path for content with shell metacharacters
# (backticks, $vars, code blocks) that would otherwise be expanded by the shell.
echo 'Body with `backticks` and $vars stays literal.' \
  | buzz messages send --channel "$CHANNEL_ID" --content - | jq .

# messages get
buzz messages get --channel "$CHANNEL_ID" | jq .
buzz messages get --channel "$CHANNEL_ID" --limit 5 | jq .

# messages thread
buzz messages thread --channel "$CHANNEL_ID" --event "$EVENT_ID" | jq .

# messages search
buzz messages search --query "Hello" | jq .
buzz messages search --query "CLI test" --limit 5 | jq .

# messages edit
buzz messages edit --event "$EVENT_ID" --content "Edited by CLI test" | jq .

# messages delete
buzz messages delete --event "$REPLY_ID" | jq .
```

### 6.4 Diff Messages

```bash
# messages send-diff from stdin
echo '--- a/foo.rs
+++ b/foo.rs
@@ -1,3 +1,3 @@
-fn old() {}
+fn new() {}' | buzz messages send-diff \
  --channel "$CHANNEL_ID" \
  --diff - \
  --repo "https://github.com/example/repo" \
  --commit "abcdef1234567890abcdef1234567890abcdef12" | jq .

# messages send-diff with metadata
echo "diff content" | buzz messages send-diff \
  --channel "$CHANNEL_ID" \
  --diff - \
  --repo "https://github.com/example/repo" \
  --commit "abcdef1234567890abcdef1234567890abcdef12" \
  --file "src/main.rs" \
  --lang "rust" \
  --description "Refactored main" | jq .

# messages send-diff with branch + PR metadata
echo "diff content" | buzz messages send-diff \
  --channel "$CHANNEL_ID" \
  --diff - \
  --repo "https://github.com/example/repo" \
  --commit "abcdef1234567890abcdef1234567890abcdef12" \
  --parent-commit "1234567890abcdef1234567890abcdef12345678" \
  --source-branch "feature/cli" \
  --target-branch "main" \
  --pr 42 | jq .
```

### 6.5 Reactions

```bash
# Send a message to react to
REACT_MSG=$(buzz messages send --channel "$CHANNEL_ID" --content "React to this")
REACT_ID=$(echo "$REACT_MSG" | jq -r '.event_id')

# reactions add
buzz reactions add --event "$REACT_ID" --emoji "👍" | jq .

# reactions get
buzz reactions get --event "$REACT_ID" | jq .
# Expected: {"reactions":[{"emoji":"...","count":N,"pubkeys":["..."]}]}

# reactions remove
buzz reactions remove --event "$REACT_ID" --emoji "👍" | jq .
```

### 6.6 DMs

```bash
# dms list
buzz dms list | jq .
# Expected: [{"dm_id":"...","participants":["..."],"created_at":N}]

# dms open (needs a real pubkey — use your own or a test one)
# Get your own pubkey first:
MY_PUBKEY=$(buzz users get | jq -r '.[0].pubkey // empty')
echo "My pubkey: $MY_PUBKEY"

# dms open with a synthetic pubkey (relay will create the user)
DM_RESULT=$(buzz dms open --pubkey "0000000000000000000000000000000000000000000000000000000000000001")
echo "$DM_RESULT" | jq .
# Expected: {"event_id":"...","accepted":true,"message":"...","dm_id":"<uuid>"}
DM_ID=$(echo "$DM_RESULT" | jq -r '.dm_id')

# dms add-member (requires messages:write scope — NOT admin:channels)
buzz dms add-member --channel "$DM_ID" \
  --pubkey "0000000000000000000000000000000000000000000000000000000000000002" | jq .
```

### 6.7 Users & Presence

```bash
# users get — own profile (0 pubkeys)
buzz users get | jq .
# Expected: [{...profile...}] — always returns an array, even for single results

# users get — single pubkey
buzz users get --pubkey "$MY_PUBKEY" | jq .

# users get — batch (2+ pubkeys)
buzz users get --pubkey "$MY_PUBKEY" --pubkey "$MY_PUBKEY" | jq .

# users set-profile
buzz users set-profile --name "CLI Test Agent" --about "Testing buzz-cli" | jq .

# users presence
buzz users presence --pubkeys "$MY_PUBKEY" | jq .

# users set-presence
buzz users set-presence --status online | jq .
buzz users set-presence --status away | jq .
buzz users set-presence --status offline | jq .
# Note: set-presence may fail — kind:20001 is ephemeral and rejected by the HTTP bridge

# users set-status — NIP-38 kind:30315 on the d:general coordinate
buzz users set-status --text "reviewing PRs" --emoji "🔍" | jq .
buzz users set-status --text "no emoji this time" | jq .

# users set-status — emoji-only status (intentional: text is blank, emoji is kept)
buzz users set-status --text "" --emoji "🎶" | jq .

# users set-status --clear — removes the status (empty content, d:general only)
buzz users set-status --clear | jq .

# --clear is mutually exclusive with --text/--emoji
buzz users set-status --clear --text "nope" 2>&1; echo "exit: $?"
# Expected: exit 1 — clap conflict error
```

### 6.8 Channel Members (add/remove require admin:channels)

```bash
# channels add-member
buzz channels add-member --channel "$CHANNEL_ID" \
  --pubkey "0000000000000000000000000000000000000000000000000000000000000001" \
  --role member | jq .

# channels members
buzz channels members --channel "$CHANNEL_ID" | jq .
# Expected: [{"pubkey":"...","role":"..."}]

# channels remove-member
buzz channels remove-member --channel "$CHANNEL_ID" \
  --pubkey "0000000000000000000000000000000000000000000000000000000000000001" | jq .
```

### 6.9 Workflows

```bash
# workflows create
# NOTE: trigger uses `on:` tag (serde internally tagged enum).
# Valid triggers: message_posted, reaction_added, diff_posted, schedule, webhook
# Steps use `action:` tag: send_message, send_dm, set_channel_topic, add_reaction, etc.
WF=$(buzz workflows create --channel "$CHANNEL_ID" \
  --yaml 'name: test-wf
trigger:
  on: webhook
steps:
  - id: step1
    action: send_message
    text: "Hello from workflow"' | jq .)
echo "$WF"
WF_ID=$(echo "$WF" | jq -r '.workflow_id')

# workflows list
buzz workflows list --channel "$CHANNEL_ID" | jq .

# workflows get
buzz workflows get --workflow "$WF_ID" | jq .
# Expected: {"workflow_id":"...","content":"<yaml>","created_at":N,"pubkey":"..."} or null

# workflows update (requires --channel)
buzz workflows update --channel "$CHANNEL_ID" --workflow "$WF_ID" \
  --yaml 'name: test-wf-updated
trigger:
  on: webhook
steps:
  - id: step1
    action: send_message
    text: "Updated"' | jq .

# workflows trigger
# NOTE: May return 400 "workflow not found" — the relay indexes workflow
# definitions into a DB table asynchronously. If the definition event hasn't
# been indexed yet, the trigger handler won't find it.
buzz workflows trigger --workflow "$WF_ID" | jq .

# workflows runs
buzz workflows runs --workflow "$WF_ID" | jq .
# Expected: [] — relay stores runs in DB, not as Nostr events; empty is normal

# workflows approve — requires a workflow run waiting for approval
# This is hard to test ad-hoc without a workflow that has an approval gate.
# Test the validation instead:
buzz workflows approve --token "00000000-0000-0000-0000-000000000000" 2>&1 || true
# Should fail with relay error (token not found), not a validation error
# To test the deny path: buzz workflows approve --token <UUID> --approved false

# workflows delete
buzz workflows delete --workflow "$WF_ID" | jq .
```

### 6.10 Feed

```bash
buzz feed get | jq .
buzz feed get --limit 5 | jq .
# Expected: [{id,pubkey,kind,content,created_at,tags}] — sig-stripped, sorted newest-first
```

### 6.11 Forum & Voting

```bash
# Send a forum post (kind 45001) to the forum channel
FORUM_POST=$(buzz messages send --channel "$FORUM_ID" \
  --content "Forum post for vote testing" --kind 45001 | jq .)
echo "$FORUM_POST"
FORUM_EVENT_ID=$(echo "$FORUM_POST" | jq -r '.event_id')

# messages vote (up)
buzz messages vote --event "$FORUM_EVENT_ID" --direction up | jq .

# messages vote (down)
buzz messages vote --event "$FORUM_EVENT_ID" --direction down | jq .
```

### 6.12 Notes (NIP-23 long-form, kind:30023)

Editable team-knowledge notes keyed by `(kind:30023, you, d=slug)`. `set` is an
idempotent upsert; `rm` is a NIP-09 a-tag deletion. Output is plain text (refs),
not JSON — except `get`/`ls`, which emit JSON.

```bash
# set (first publish — --title required, body from stdin)
cat <<'EOF' | buzz notes set --name dco-check --title "DCO Check" \
  --summary "How we verify DCO" --tag dco --tag ci --content -
Run `git log --format='%(trailers:key=Signed-off-by)'` ...
EOF
# → prints event_id / naddr / coordinate / slug / title

# set (edit — omit --title to carry it forward; published_at preserved)
echo "Updated body." | buzz notes set --name dco-check --content -

# get by name (own author resolves directly; cross-author #d query otherwise)
buzz notes get --name dco-check | jq .
buzz notes get --name dco-check --content-only

# get by naddr (exact coordinate; paste the naddr from a set/get above)
buzz notes get --naddr "$NADDR" | jq .

# ls (own by default; --author all across the team; --tag filters)
buzz notes ls | jq .
buzz notes ls --tag dco | jq .
buzz notes ls --author all --limit 10 | jq .

# rm (NIP-09 a-tag deletion; subsequent get must 404)
buzz notes rm --name dco-check
# → prints deleted <coordinate> / deletion <event-id>
buzz notes get --name dco-check   # exits non-zero: not found

# rm of a slug you never published → NotFound, no kind:5 emitted
buzz notes rm --name does-not-exist   # exits non-zero
```

---

## 7. Chat-native Blocks

Block reads always use explicit kind filters. Manifest and data files are
validated locally before a write is signed.

```bash
# Catalog and immutable manifests
buzz blocks list | jq .
buzz blocks get --handle lead-card | jq .
buzz blocks draft --manifest manifest.json | jq .
buzz blocks test --manifest manifest.json --data data.json | jq .

# Publish an ordinary kind:9 message with a pinned manifest
buzz blocks invoke \
  --channel "$CHANNEL_ID" \
  --handle lead-card \
  --data data.json \
  --fallback fallback.md | jq .

# Inspect and answer actions
buzz blocks actions --channel "$CHANNEL_ID" --instance "$INSTANCE_EVENT_ID" | jq .
buzz blocks act \
  --channel "$CHANNEL_ID" \
  --instance "$INSTANCE_EVENT_ID" \
  --action submit \
  --input input.json \
  --idempotency-key "$IDEMPOTENCY_KEY" | jq .
buzz blocks receipt \
  --channel "$CHANNEL_ID" \
  --action "$ACTION_EVENT_ID" \
  --instance "$INSTANCE_EVENT_ID" \
  --status succeeded \
  --result result.json | jq .
```

`buzz agents draft-create` and `buzz agents draft-update` now publish persisted
`agent-proposal` Block messages. Verify the returned JSON contains
`proposal_saved:true` and `agent_changed:false`, and verify the stored event is
kind `9`, channel-scoped, owner-addressed, attention-marked, and contains no
credential or backend configuration fields. Posting a proposal never means the
agent was created or changed.

---

## 7b. Colony company work records

Company, Initiative, and Task heads are **relay-authored**. The CLI never signs
one. `put` and `complete` publish an owner-signed Company Action (kind 40013);
the relay validates it, signs the replacement head, and returns a receipt
(kind 40014). Reads resolve heads authored by the relay signer only.

Mutations require the signing key to be the community's current **human owner**.
A managed agent can `list` and `get`, but its `put` is refused — agents request
changes in chat and an owner authorizes them.

Use placeholder ids and no real client data below.

### Create a company

```bash
cat > /tmp/company.json <<'JSON'
{
  "schema": "colony.company/v1",
  "id": "horizon-labs",
  "tradingName": "Horizon Labs",
  "legalName": null,
  "website": null,
  "summary": "Digital services studio",
  "businessType": "agency",
  "services": [
    { "id": "web", "name": "Web", "description": "Websites" }
  ],
  "customerSegments": ["smb"],
  "costCentres": [
    { "id": "internal", "name": "Internal", "kind": "internal", "serviceId": null }
  ],
  "sourceReportEventId": null,
  "onboardingStatus": "draft",
  "createdAt": 1000,
  "updatedAt": 1000
}
JSON

buzz company put --file /tmp/company.json
buzz company get --id horizon-labs
```

`put` prints one stable envelope. `receipt` is the relay's signed verdict:

```json
{
  "event_id": "<hex>",
  "accepted": true,
  "message": "",
  "entity_id": "horizon-labs",
  "request_id": "<uuid>",
  "idempotency_key": "<uuid>",
  "receipt": { "kind": 40014, "...": "..." }
}
```

### Create an initiative and two tasks

An Initiative needs a cost centre that exists on the Company. A Task needs an
owning Team whose lead is a member, and a QA persona drawn from that team — so
create the two teams first (`buzz agents` / the desktop Agents tab) and use
their real ids.

```bash
buzz initiatives put --file /tmp/initiative.json
buzz tasks put --file /tmp/task-copy.json
buzz tasks put --file /tmp/task-build.json

buzz initiatives list --company horizon-labs
buzz tasks list --company horizon-labs
buzz tasks list --initiative init-homepage
```

### Complete a task

`complete` reads the current head, changes only `status`, and sends the head it
read as the compare-and-set token — so a concurrent edit loses rather than
being silently overwritten.

```bash
buzz tasks complete --id task-copy
buzz tasks get --id task-copy    # status is now "completed"
```

### Expected refusals

These are the behaviours worth confirming by hand, because they are what keeps
company state consistent:

```bash
# Replacing a record that changed underneath you: exit 5, conflict receipt.
buzz tasks complete --id task-copy   # run twice; the second loses

# A non-owner (e.g. a managed agent key) cannot mutate.
BUZZ_PRIVATE_KEY=$AGENT_KEY buzz company put --file /tmp/company.json

# A record whose referenced company or team does not exist is refused.
buzz tasks put --file /tmp/task-with-unknown-team.json
```

Compact output works as a **global** flag, before the subcommand:

```bash
buzz --format compact tasks list --company horizon-labs
```

## 7c. Colony parties, and the views over them

A Party is one real-world business or person. Lead and Client are **views** over
that identity, not separate records, so a lead that converts keeps its history
instead of being retyped as a client. Party, alias, and relationship heads are
all relay-authored (kinds 30182 / 30183); the CLI never signs one. Writes
publish an owner-signed Party Action (kind 40015) and the relay returns a
receipt (kind 40016). Mutations require the community's current **human owner**.

Use placeholder ids and no real client data below.

### Create a party and give it a Lead view

```bash
cat > /tmp/party.json <<'JSON'
{
  "schema": "colony.party/v1",
  "id": "acme-industries",
  "companyId": "horizon-labs",
  "kind": "organization",
  "displayName": "Acme Industries",
  "legalName": null,
  "identifiers": [
    { "scheme": "domain", "value": "acme.example", "confidence": "asserted" }
  ],
  "provenance": [
    {
      "id": "prov-01",
      "source": "discovery:google-maps",
      "observedAt": 1785369600,
      "sourceRef": null,
      "fields": ["displayName"]
    }
  ],
  "retiredHandles": [],
  "createdAt": 1785369600,
  "updatedAt": 1785369600
}
JSON

buzz parties create --file /tmp/party.json
buzz parties get --id acme-industries
```

The Lead view lives at the derived coordinate `<partyId>:lead`. Any other `id`
is refused — that derivation is what makes a second Lead on one party
structurally impossible. `ownerPersonaId` must be a persona that exists.

```bash
cat > /tmp/lead.json <<'JSON'
{
  "schema": "colony.party.relationship/v1",
  "id": "acme-industries:lead",
  "companyId": "horizon-labs",
  "partyId": "acme-industries",
  "relationship": "lead",
  "status": "candidate",
  "ownerPersonaId": "<a persona id from `buzz agents`>",
  "sourceChannelId": "<channel id>",
  "createdAt": 1785369600,
  "updatedAt": 1785369600
}
JSON

buzz parties relate --file /tmp/lead.json
buzz parties get --id acme-industries    # party plus its views
```

### Both views at once

Change `relationship` to `client`, `status` to `active`, and `id` to
`acme-industries:client`, then `relate` again. `parties get` now returns both,
each with its own status and its own accountable persona. Disqualifying the
Lead leaves the Client untouched — they are separate coordinates.

### Resolve an observation before creating a duplicate

`resolve` reads only. It never writes on the strength of its own answer.

```bash
echo '[{"scheme":"domain","value":"acme.example","confidence":"asserted"}]' \
  > /tmp/observed.json
buzz parties resolve --company horizon-labs --file /tmp/observed.json
# {"resolution":"resolved","handle":"acme-industries","matched_on":{...}}
```

Worth confirming by hand, because these are the decisions that determine
whether a business ends up as one record or two:

```bash
# Same text under a different scheme is NOT a match — two different claims.
echo '[{"scheme":"email","value":"acme.example","confidence":"asserted"}]' \
  > /tmp/wrong-scheme.json
buzz parties resolve --company horizon-labs --file /tmp/wrong-scheme.json
# {"resolution":"no-match"}

# Identifiers spread across two parties are ambiguous, never a pick.
# Create a second party holding one of the identifiers, then resolve both.
# {"resolution":"ambiguous","candidates":["...","..."],"next":"..."}
```

### Merge, and the handle that has to survive it

Create `acme-old` carrying an identifier the first party lacks, give it a Lead
view, then fold it in:

```bash
buzz parties merge --survivor acme-industries --retire acme-old

# The retired handle still arrives. This is the whole point: a reference
# handed out months ago, in a task or an agent's work context, must resolve.
buzz parties get --id acme-old
# {"requested":"acme-old","handle":"acme-industries","merges_followed":1,...}

# Identifiers and provenance from both sides survive, deduplicated.
# The Lead view moved with the identity: acme-industries:lead now holds it.
buzz parties list --company horizon-labs
# retired_handles lists acme-old separately — it is not a party.
```

Chain a second merge (`acme-industries` into a third handle) and confirm
`buzz parties get --id acme-old` still resolves, now with `merges_followed: 2`.

### Expected refusals

```bash
# Merging a handle that is already retired.
buzz parties merge --survivor acme-industries --retire acme-old

# Merging a party into itself, directly or through an alias.
buzz parties merge --survivor acme-industries --retire acme-industries

# Parties from different companies never merge.
buzz parties merge --survivor acme-industries --retire <party-in-another-company>

# A relationship whose party does not exist.
buzz parties relate --file /tmp/lead-for-unknown-party.json

# A relationship id that is not derived from its coordinate.
# (edit /tmp/lead.json to id "acme-industries:prospect")
buzz parties relate --file /tmp/lead.json

# A Client status on a Lead view, e.g. "active" on relationship "lead".
buzz parties relate --file /tmp/confused-lead.json

# An ended view meeting a live one on merge. Set acme-old's Lead to
# "disqualified" and acme-industries' Lead to "qualified", then merge:
# refused with a signed receipt, because both answers are wrong in a way
# nobody would notice. A human settles it first.
buzz parties merge --survivor acme-industries --retire acme-old

# A non-owner (e.g. a managed agent key) cannot mutate.
BUZZ_PRIVATE_KEY=$AGENT_KEY buzz parties create --file /tmp/party.json
```

---

## 8. Error Path Testing

Verify the CLI produces correct JSON on stderr and correct exit codes.

```bash
# Exit 1: Invalid UUID
buzz channels get --channel "not-a-uuid" 2>&1; echo "exit: $?"
# stderr: {"error":"user_error","message":"invalid UUID: not-a-uuid"}
# exit: 1

# Exit 1: Invalid hex64
buzz messages delete --event "not-hex" 2>&1; echo "exit: $?"
# stderr: {"error":"user_error","message":"must be a 64-character hex string: not-hex"}
# exit: 1

# Exit 1: Invalid --type value (clap validates the enum — multi-line error)
buzz channels create --name x --type invalid --visibility open 2>&1; echo "exit: $?"
# stderr: {"error":"user_error","message":"error: invalid value 'invalid' for '--type <CHANNEL_TYPE>'\n  [possible values: stream, forum]\n..."}
# exit: 1

# Exit 1: Invalid --direction value
buzz messages vote --event "$(printf '0%.0s' {1..64})" \
  --direction sideways 2>&1; echo "exit: $?"
# exit: 1

# Exit 1: Empty body guard
buzz users set-profile 2>&1; echo "exit: $?"
# exit: 1 (at least one field required)

# Exit 3: No auth configured
env -u BUZZ_PRIVATE_KEY \
  cargo run -p buzz-cli -- channels list 2>&1; echo "exit: $?"
# stderr: {"error":"auth_error","message":"auth error: BUZZ_PRIVATE_KEY is required (use --private-key or set env var)"}
# exit: 3

# Not-found returns null, not an error (exit 0)
buzz channels get --channel "00000000-0000-0000-0000-000000000000"
# stdout: null
# exit: 0
```

---

## 9. Auth Testing

Test authentication.

```bash
# Private key (BUZZ_PRIVATE_KEY)
BUZZ_PRIVATE_KEY="nsec1..." buzz channels list | jq .
# Should succeed

# No auth → exit 3
env -u BUZZ_PRIVATE_KEY \
  cargo run -p buzz-cli -- channels list 2>&1; echo "exit: $?"
# stderr: {"error":"auth_error","message":"auth error: BUZZ_PRIVATE_KEY is required (use --private-key or set env var)"}
# exit: 3
```

---

## 10. Cleanup

```bash
# Delete test channels
buzz channels delete --channel "$CHANNEL_ID" | jq .
buzz channels delete --channel "$FORUM_ID" | jq .
```

---

## 11. Checklist

| # | Command | Tested | Notes |
|---|---------|:------:|-------|
| 1 | `messages send` | ☐ | Basic, reply, broadcast, mentions, stdin |
| 2 | `messages send-diff` | ☐ | Stdin, metadata, branch/PR |
| 3 | `messages edit` | ☐ | |
| 4 | `messages delete` | ☐ | |
| 5 | `messages get` | ☐ | With limit |
| 6 | `messages thread` | ☐ | |
| 7 | `messages search` | ☐ | With limit |
| 8 | `messages vote` | ☐ | Up and down |
| 9 | `channels list` | ☐ | With visibility, member |
| 10 | `channels get` | ☐ | |
| 11 | `channels create` | ☐ | Stream and forum |
| 12 | `channels update` | ☐ | |
| 13 | `channels topic` | ☐ | |
| 14 | `channels purpose` | ☐ | |
| 15 | `channels join` | ☐ | |
| 16 | `channels leave` | ☐ | |
| 17 | `channels archive` | ☐ | Needs admin:channels |
| 18 | `channels unarchive` | ☐ | Needs admin:channels |
| 19 | `channels delete` | ☐ | Needs admin:channels |
| 20 | `channels members` | ☐ | |
| 21 | `channels add-member` | ☐ | Needs admin:channels |
| 22 | `channels remove-member` | ☐ | Needs admin:channels |
| 23 | `canvas get` | ☐ | Channel + `--thread` variants |
| 24 | `canvas set` | ☐ | Direct, stdin, and `--thread` variants; over-cap rejection |
| 25 | `reactions add` | ☐ | |
| 26 | `reactions remove` | ☐ | |
| 27 | `reactions get` | ☐ | |
| 28 | `dms list` | ☐ | |
| 29 | `dms open` | ☐ | |
| 30 | `dms add-member` | ☐ | Needs messages:write |
| 31 | `users get` | ☐ | Self, single, batch |
| 32 | `users set-profile` | ☐ | |
| 33 | `users presence` | ☐ | |
| 34 | `users set-presence` | ☐ | online, away, offline |
| 35 | `workflows list` | ☐ | |
| 36 | `workflows create` | ☐ | |
| 37 | `workflows update` | ☐ | |
| 38 | `workflows delete` | ☐ | |
| 39 | `workflows trigger` | ☐ | |
| 40 | `workflows runs` | ☐ | |
| 41 | `workflows get` | ☐ | |
| 42 | `workflows approve` | ☐ | Validation only (needs approval gate); bare = approve, `--approved false` = deny |
| 43 | `feed get` | ☐ | |
| 44 | `social publish` | ☐ | |
| 45 | `social set-contacts` | ☐ | |
| 46 | `social event` | ☐ | |
| 47 | `social notes` | ☐ | |
| 48 | `social contacts` | ☐ | |
| 49 | `repos create` | ☐ | |
| 50 | `repos get` | ☐ | |
| 51 | `repos list` | ☐ | |
| 52 | `repos protect list` | ☐ | Empty/populated rules; unknown rules visible; malformed rule reported in validation_error |
| 53 | `repos protect set` | ☐ | Create and replace complete exact-ref rule; verify metadata is preserved |
| 54 | `repos protect remove` | ☐ | Remove exact ref; missing rule → NotFound |
| 55 | `upload file` | ☐ | |
| 56 | `pack validate` | ☐ | Local, no relay |
| 57 | `pack inspect` | ☐ | Local, no relay |
| 58 | `notes set` | ☐ | First publish, edit/carry, --clear-tags, ambiguity, empty-stdin guard |
| 59 | `notes get` | ☐ | By name, by naddr, --content-only, cross-author, ambiguous → exit 1 |
| 60 | `notes ls` | ☐ | Own, --author all, --tag, --limit |
| 61 | `notes rm` | ☐ | Delete→get 404, double-delete idempotent, missing slug → NotFound |
| 62 | `users set-status` | ☐ | Text+emoji, text only, emoji-only (`--text ""`), `--clear`, `--clear` + `--text` → exit 1 |
| 63 | `parties create` | ☐ | Create; replace via CAS; unknown schema → exit 1 |
| 64 | `parties get` | ☐ | Live handle; retired handle resolves with `merges_followed`; chained merges |
| 65 | `parties list` | ☐ | Scoped to one company; retired handles listed separately |
| 66 | `parties relate` | ☐ | Lead and Client at once; wrong coordinate refused; cross-view status refused |
| 67 | `parties resolve` | ☐ | Exact typed match; different scheme → no-match; two candidates → ambiguous |
| 68 | `parties merge` | ☐ | Alias written; views re-pointed; already-retired, self, cross-company, ended-vs-live all refused |
