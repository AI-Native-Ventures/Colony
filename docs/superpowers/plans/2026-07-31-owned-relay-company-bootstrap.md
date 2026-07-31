# Owned Relay Company Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and prove an AI Native Office desktop distribution that opens directly into one company workspace on a Buzz relay we operate, while preserving Nostr identity, relay-enforced membership, managed-agent delegation, and the optional Builderlab flow.

**Architecture:** Reuse the current `BUZZ_RELAY_URL` and `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` compile-time boundary rather than adding product UI or another authentication layer. Add a guarded owned-distribution build wrapper, a deterministic production Compose bootstrap, regression assertions around first-run behavior, and an operations runbook. Keep deployment and packaged-app live proof as explicit gates that require approved infrastructure inputs.

**Tech Stack:** Bash, Just, Tauri 2/Rust build configuration, React 19/TypeScript, Playwright, Docker Compose, Caddy, Postgres, Redis, MinIO, Nostr/NIP-42/NIP-OA.

---

## Scope Guardrails

- The default owned-company path must remain chat-first and page-free: identity, relay, profile/welcome, then chat.
- Builderlab stays functional only behind its existing explicit hosted-community actions.
- Do not create a new auth provider, company picker, control plane, billing system, or Cloudflare Worker relay.
- Do not rename internal Buzz symbols or protocols in this phase.
- Do not put a human or agent private key in `.env`, localStorage, logs, build output, or test fixtures.
- Do not deploy publicly or rotate production secrets until the user has approved the domain, host, owner public key, and recurring infrastructure cost.
- Keep implemented, locally tested, packaged, deployed, and live-proven as distinct states.

## Acceptance Gates

1. **Distribution contract:** invalid or local relay URLs are rejected, and the accepted build invokes the existing Tauri release path with the relay and auto-connect flag embedded.
2. **Deployment contract:** one command creates a mode-`600` Compose `.env` with an explicit owner public key, stable generated secrets, closed membership, and no placeholders or private owner key.
3. **Desktop regression:** a fresh owned build stores exactly one community with the current public key, stores no `nsec`, shows no community chooser, and invokes no Builderlab command.
4. **Local quality:** focused shell contracts, desktop unit checks, compiled-flag tests, targeted Playwright integration, and repository checks pass.
5. **Relay live proof:** the approved public hostname is healthy, maps to the intended community, fails closed for unknown hosts, persists data across restart, and enforces owner/member/agent authorization.
6. **Packaged product proof:** a fresh packaged app enters the owned company without Builderlab, sends chat messages, starts an agent, receives an agent response, and preserves human/community/agent identities after restart.

## Task 1: Add the Owned Desktop Distribution Contract

**Files:**

- Create: `scripts/test-owned-desktop-build-contract.sh`
- Create: `scripts/build-owned-desktop.sh`
- Modify: `Justfile`

### Step 1: Write the failing shell contract

- [ ] Create `scripts/test-owned-desktop-build-contract.sh` with small assertion helpers.
- [ ] Exercise only the wrapper's dry-run boundary so this test does not compile the desktop app.
- [ ] Assert all of the following:
  - no `--relay` and no `BUZZ_OWNED_RELAY_URL` exits non-zero;
  - `ws://office.example.com`, `https://office.example.com`, malformed input, credentials, query strings, fragments, and non-root paths exit non-zero;
  - `wss://localhost`, `wss://127.0.0.1`, `wss://[::1]`, `wss://0.0.0.0`, and raw public IP addresses exit non-zero;
  - `wss://office.example.com` succeeds;
  - the dry-run output includes `BUZZ_RELAY_URL=wss://office.example.com`;
  - the dry-run output includes `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1`;
  - the dry-run output includes `just desktop-release-build <target>`;
  - `--target x86_64-apple-darwin` is preserved;
  - `BUZZ_OWNED_RELAY_URL=wss://office.example.com` works when `--relay` is absent.

Use this test shape:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="${REPO_ROOT}/scripts/build-owned-desktop.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_rejected() {
  if BUZZ_OWNED_BUILD_DRY_RUN=1 "${BUILD_SCRIPT}" "$@" >/dev/null 2>&1; then
    fail "expected rejection: $*"
  fi
}

expect_output() {
  local output="$1"
  local expected="$2"
  [[ "${output}" == *"${expected}"* ]] ||
    fail "expected output to contain: ${expected}"
}

expect_rejected
expect_rejected --relay ws://office.example.com
expect_rejected --relay https://office.example.com
expect_rejected --relay wss://user:pass@office.example.com
expect_rejected --relay 'wss://office.example.com?tenant=horizon'
expect_rejected --relay 'wss://office.example.com#fragment'
expect_rejected --relay wss://office.example.com/socket
expect_rejected --relay wss://localhost
expect_rejected --relay wss://127.0.0.1
expect_rejected --relay 'wss://[::1]'
expect_rejected --relay wss://0.0.0.0
expect_rejected --relay wss://192.0.2.1

output="$(
  BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" \
    --relay wss://office.example.com \
    --target x86_64-apple-darwin
)"
expect_output "${output}" "BUZZ_RELAY_URL=wss://office.example.com"
expect_output "${output}" "BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1"
expect_output "${output}" "just desktop-release-build x86_64-apple-darwin"

output="$(
  BUZZ_OWNED_RELAY_URL=wss://office.example.com \
    BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" \
    --target aarch64-apple-darwin
)"
expect_output "${output}" "just desktop-release-build aarch64-apple-darwin"

echo "owned desktop build contract passed"
```

### Step 2: Run it and prove the red state

- [ ] Run:

```bash
bash scripts/test-owned-desktop-build-contract.sh
```

Expected: non-zero exit because `scripts/build-owned-desktop.sh` does not exist.

### Step 3: Implement the smallest guarded build wrapper

- [ ] Create `scripts/build-owned-desktop.sh`.
- [ ] Resolve the repository root from the script location and always invoke `just` from that root.
- [ ] Accept `--relay <url>` and optional `--target <triple>`.
- [ ] Fall back to `BUZZ_OWNED_RELAY_URL` for the relay.
- [ ] If no target is supplied, derive it from `rustc -vV`'s `host:` line and reject an empty result.
- [ ] Validate the relay with Node's `URL` parser:
  - protocol is exactly `wss:`;
  - username and password are empty;
  - pathname is empty or `/`;
  - search and hash are empty;
  - hostname is a multi-label DNS name, not an IP address, `.local` name, loopback, or wildcard host.
- [ ] Use `BUZZ_OWNED_BUILD_DRY_RUN=1` to print, not execute, the exact build contract.
- [ ] For a real build, clear `BUZZ_RELAY_HTTP`, export `BUZZ_RELAY_URL` and `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1`, then run `just desktop-release-build "$target"`.
- [ ] Mark both scripts executable:

```bash
chmod +x scripts/build-owned-desktop.sh scripts/test-owned-desktop-build-contract.sh
```

The central implementation should be:

```bash
validate_relay_url() {
  node - "${1}" <<'NODE'
const { isIP } = require("node:net");
const raw = process.argv[2];
let url;
try {
  url = new URL(raw);
} catch {
  process.exit(1);
}

const host = url.hostname
  .toLowerCase()
  .replace(/^\[/, "")
  .replace(/\]$/, "");
const valid =
  url.protocol === "wss:" &&
  url.username === "" &&
  url.password === "" &&
  (url.pathname === "" || url.pathname === "/") &&
  url.search === "" &&
  url.hash === "" &&
  host.includes(".") &&
  isIP(host) === 0 &&
  host !== "localhost" &&
  !host.endsWith(".localhost") &&
  !host.endsWith(".local");

process.exit(valid ? 0 : 1);
NODE
}

if [[ "${BUZZ_OWNED_BUILD_DRY_RUN:-0}" == "1" ]]; then
  printf 'BUZZ_RELAY_URL=%s BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1 just desktop-release-build %s\n' \
    "${relay_url}" "${target}"
  exit 0
fi

cd "${REPO_ROOT}"
unset BUZZ_RELAY_HTTP
export BUZZ_RELAY_URL="${relay_url}"
export BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1
exec just desktop-release-build "${target}"
```

### Step 4: Wire the contract into Just

- [ ] Add these recipes near `desktop-release-build`:

```just
# Build an owned-company desktop distribution for a reviewed public relay.
desktop-owned-build relay *ARGS:
    ./scripts/build-owned-desktop.sh --relay "{{relay}}" {{ARGS}}

# Fast contracts for owned desktop and relay distribution tooling.
owned-distribution-contract:
    bash scripts/test-owned-desktop-build-contract.sh
```

- [ ] Add `owned-distribution-contract` to the root `check` dependency list so URL safety cannot regress silently.

### Step 5: Run focused proof

- [ ] Run:

```bash
bash -n scripts/build-owned-desktop.sh scripts/test-owned-desktop-build-contract.sh
bash scripts/test-owned-desktop-build-contract.sh
just owned-distribution-contract
```

Expected final lines:

```text
owned desktop build contract passed
```

### Step 6: Commit the build boundary

- [ ] Activate Hermit, stage only this task's files, and commit with DCO:

```bash
. ./bin/activate-hermit
git add scripts/build-owned-desktop.sh scripts/test-owned-desktop-build-contract.sh Justfile
git commit -s -m "feat(desktop): add owned relay distribution build"
```

## Task 2: Add Deterministic Compose Bootstrap

**Files:**

- Create: `deploy/compose/test-bootstrap.sh`
- Create: `deploy/compose/bootstrap.sh`
- Modify: `deploy/compose/run.sh`
- Modify: `Justfile`

### Step 1: Write the failing bootstrap contract

- [ ] Create `deploy/compose/test-bootstrap.sh`.
- [ ] Use `mktemp -d` and remove it on exit.
- [ ] Use a fixed public owner fixture such as 64 `a` characters; never generate or log a private owner key.
- [ ] Assert:
  - a valid lowercase domain and 64-hex owner public key produce the requested output;
  - the output mode is `600` on macOS and Linux;
  - `BUZZ_DOMAIN`, `RELAY_URL`, media URLs, CORS origin, owner public key, and optional image are exact;
  - closed membership, NIP-OA, auth-token requirement, and auto-migration remain `true`;
  - no `CHANGE_ME` remains;
  - relay, hook, Postgres, Redis, and S3 secrets are non-empty;
  - independent secrets are not identical;
  - uppercase domains, schemes, paths, whitespace, localhost, loopback/wildcard hosts, and malformed owner keys are rejected;
  - an existing output file is never overwritten.

Use helpers equivalent to:

```bash
env_value() {
  local key="$1"
  local file="$2"
  sed -n "s/^${key}=//p" "${file}"
}

file_mode() {
  stat -f "%Lp" "$1" 2>/dev/null || stat -c "%a" "$1"
}

assert_secret() {
  local value
  value="$(env_value "$1" "$2")"
  [[ "${value}" =~ ^[0-9a-f]{64}$ ]] ||
    fail "$1 must be 64 lowercase hex characters"
}
```

### Step 2: Run it and prove the red state

- [ ] Run:

```bash
bash deploy/compose/test-bootstrap.sh
```

Expected: non-zero exit because `deploy/compose/bootstrap.sh` does not exist.

### Step 3: Implement the bootstrap generator

- [ ] Create `deploy/compose/bootstrap.sh` with:
  - required `--domain <host>`;
  - required `--owner-pubkey <64-hex>`;
  - optional `--image <reference>`;
  - optional `--output <path>`, defaulting to `deploy/compose/.env`;
  - `--help`;
  - rejection of unknown arguments and missing argument values.
- [ ] Validate the domain as an already-lowercase DNS hostname without a scheme, port, path, whitespace, wildcard, loopback, or trailing dot.
- [ ] Validate the owner public key as exactly 64 hexadecimal characters and write it lowercase.
- [ ] Reject an empty image string.
- [ ] Refuse to overwrite any existing output path.
- [ ] Require `openssl`, set `umask 077`, generate each stable secret independently with `openssl rand -hex 32`, and install the result with mode `600`.
- [ ] Render from `deploy/compose/.env.example`; replace complete `KEY=value` lines with `awk` rather than broad string replacement.
- [ ] Reject the generated temporary file if any `CHANGE_ME` remains.
- [ ] Print the generated path and an explicit reminder that the human owner private key is external and must be backed up separately.
- [ ] Mark both scripts executable:

```bash
chmod +x deploy/compose/bootstrap.sh deploy/compose/test-bootstrap.sh
```

The rendering boundary should follow this form:

```bash
generate_secret() {
  openssl rand -hex 32
}

awk \
  -v image="${image}" \
  -v domain="${domain}" \
  -v owner="${owner_pubkey}" \
  -v relay_key="$(generate_secret)" \
  -v hook_secret="$(generate_secret)" \
  -v postgres_password="$(generate_secret)" \
  -v redis_password="$(generate_secret)" \
  -v s3_access_key="$(generate_secret)" \
  -v s3_secret_key="$(generate_secret)" '
BEGIN { FS = "=" }
$1 == "BUZZ_IMAGE" { print "BUZZ_IMAGE=" image; next }
$1 == "BUZZ_DOMAIN" { print "BUZZ_DOMAIN=" domain; next }
$1 == "RELAY_URL" { print "RELAY_URL=wss://" domain; next }
$1 == "BUZZ_MEDIA_BASE_URL" {
  print "BUZZ_MEDIA_BASE_URL=https://" domain "/media"; next
}
$1 == "BUZZ_MEDIA_SERVER_DOMAIN" {
  print "BUZZ_MEDIA_SERVER_DOMAIN=" domain; next
}
$1 == "BUZZ_CORS_ORIGINS" {
  print "BUZZ_CORS_ORIGINS=https://" domain; next
}
$1 == "RELAY_OWNER_PUBKEY" { print "RELAY_OWNER_PUBKEY=" owner; next }
$1 == "BUZZ_RELAY_PRIVATE_KEY" {
  print "BUZZ_RELAY_PRIVATE_KEY=" relay_key; next
}
$1 == "BUZZ_GIT_HOOK_HMAC_SECRET" {
  print "BUZZ_GIT_HOOK_HMAC_SECRET=" hook_secret; next
}
$1 == "POSTGRES_PASSWORD" {
  print "POSTGRES_PASSWORD=" postgres_password; next
}
$1 == "REDIS_PASSWORD" {
  print "REDIS_PASSWORD=" redis_password; next
}
$1 == "BUZZ_S3_ACCESS_KEY" {
  print "BUZZ_S3_ACCESS_KEY=" s3_access_key; next
}
$1 == "BUZZ_S3_SECRET_KEY" {
  print "BUZZ_S3_SECRET_KEY=" s3_secret_key; next
}
{ print }
' "${SCRIPT_DIR}/.env.example" >"${temporary_file}"
```

### Step 4: Correct the existing owner-key backup wording

- [ ] In `deploy/compose/run.sh`, replace:

```text
- The owner private key if bootstrap generated one for RELAY_OWNER_PUBKEY
```

with:

```text
- The owner private key and recovery backup held outside this deployment
```

This makes the operational message match the security boundary: deployment tooling never creates or stores the human private key.

### Step 5: Add the bootstrap test to the fast contract

- [ ] Extend `owned-distribution-contract`:

```just
owned-distribution-contract:
    bash scripts/test-owned-desktop-build-contract.sh
    bash deploy/compose/test-bootstrap.sh
```

### Step 6: Run focused proof

- [ ] Run:

```bash
bash -n deploy/compose/bootstrap.sh deploy/compose/test-bootstrap.sh deploy/compose/run.sh
bash deploy/compose/test-bootstrap.sh
just owned-distribution-contract
```

Expected final lines:

```text
compose bootstrap contract passed
owned desktop build contract passed
compose bootstrap contract passed
```

### Step 7: Commit the deployment bootstrap

- [ ] Activate Hermit, stage only this task's files, and commit:

```bash
. ./bin/activate-hermit
git add deploy/compose/bootstrap.sh deploy/compose/test-bootstrap.sh deploy/compose/run.sh Justfile
git commit -s -m "feat(deploy): bootstrap owned relay environment"
```

## Task 3: Pin the Builderlab-Free First-Run Path

**Files:**

- Modify: `desktop/tests/e2e/onboarding.spec.ts`

### Step 1: Strengthen the existing owned-default regression

- [ ] Extend `test("non-local default auto-connects when the release flag is enabled", ...)`.
- [ ] Keep the current active-community and relay assertions.
- [ ] Return and compare this additional state from the localStorage poll:
  - stored `pubkey`;
  - whether the stored object has its own `nsec` property.
- [ ] Assert the `Join a community` button and `community-choice-create` are absent.
- [ ] Poll the E2E command log and assert no invoked command contains `builderlab`.

The completed assertion should include:

```ts
await expect
  .poll(() =>
    page.evaluate(() => {
      const raw = window.localStorage.getItem("buzz-communities");
      const communities = raw
        ? (JSON.parse(raw) as Array<{
            id: string;
            relayUrl: string;
            pubkey?: string;
            nsec?: string;
          }>)
        : [];
      const community = communities[0];
      return {
        activeMatchesCommunity:
          communities.length === 1 &&
          window.localStorage.getItem("buzz-active-community-id") ===
            community?.id,
        relayUrl: community?.relayUrl ?? null,
        pubkey: community?.pubkey ?? null,
        hasNsec: community
          ? Object.hasOwn(community, "nsec")
          : null,
      };
    }),
  )
  .toEqual({
    activeMatchesCommunity: true,
    relayUrl: "wss://default.example.com",
    pubkey: BLANK_TYLER_IDENTITY.pubkey,
    hasNsec: false,
  });

await expect(
  page.getByRole("button", { name: /Join a community/ }),
).toHaveCount(0);
await expect(page.getByTestId("community-choice-create")).toHaveCount(0);
await expect
  .poll(() =>
    page.evaluate(
      () =>
        window.__BUZZ_E2E_COMMANDS__?.filter((command) =>
          command.includes("builderlab"),
        ) ?? [],
    ),
  )
  .toEqual([]);
```

This is a characterization test for behavior that should already exist. If it fails, diagnose the observed command or storage state before changing production code.

### Step 2: Build the E2E bundle correctly

- [ ] Kill a stale preview server on port `4173` if one is serving an older bundle.
- [ ] Run:

```bash
cd desktop
pnpm build:e2e
pnpm exec playwright test tests/e2e/onboarding.spec.ts \
  --project=integration \
  --grep "non-local default auto-connects when the release flag is enabled"
```

Expected: `1 passed`.

### Step 3: Protect the existing optional flows

- [ ] Run the entire onboarding spec:

```bash
cd desktop
pnpm exec playwright test tests/e2e/onboarding.spec.ts --project=integration
```

Expected: all onboarding tests pass, including existing Builderlab create/join tests and custom-relay tests.

### Step 4: Commit the regression proof

- [ ] Activate Hermit, stage only the spec, and commit:

```bash
. ./bin/activate-hermit
git add desktop/tests/e2e/onboarding.spec.ts
git commit -s -m "test(desktop): pin owned relay bootstrap path"
```

## Task 4: Write the Owned Relay Operations Runbook

**Files:**

- Create: `docs/operations/owned-relay-runbook.md`
- Modify: `deploy/compose/README.md`

### Step 1: Write the runbook around explicit authority gates

- [ ] Create `docs/operations/owned-relay-runbook.md` with these sections:
  1. purpose and non-goals;
  2. required approved inputs;
  3. owner identity preparation;
  4. origin-host prerequisites;
  5. DNS, TLS, and WebSocket proxying;
  6. Compose bootstrap and config validation;
  7. first deployment;
  8. relay acceptance checks;
  9. owned desktop build;
  10. packaged desktop and agent acceptance;
  11. backup, upgrade, rollback, and incident notes;
  12. proof-state reporting template.
- [ ] State that Cloudflare may terminate/proxy DNS, TLS, and WebSockets, but Buzz still runs on an origin host with persistent Postgres, Redis, object, and git storage.
- [ ] State that the owner public key is infrastructure input while the owner private key remains in the user's keyring and encrypted recovery backup.
- [ ] Require a pinned image digest or immutable `sha-...` tag before public release.

Use these exact local preparation commands:

```bash
: "${OWNED_DOMAIN:?Set the approved public relay domain}"
: "${OWNER_PUBKEY:?Set the approved 64-character hex Nostr public key}"

./deploy/compose/bootstrap.sh \
  --domain "${OWNED_DOMAIN}" \
  --owner-pubkey "${OWNER_PUBKEY}"

BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh config
```

Document these first-deployment commands:

```bash
BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh start
curl -fsS "https://${OWNED_DOMAIN}/_liveness"
curl -fsS "https://${OWNED_DOMAIN}/_readiness"
./deploy/compose/run.sh status
./deploy/compose/run.sh list-members
```

Document the distribution command:

```bash
just desktop-owned-build "wss://${OWNED_DOMAIN}"
```

### Step 2: Define relay-level live evidence

- [ ] Require evidence for:
  - public DNS and certificate;
  - WebSocket upgrade through the public hostname;
  - `/_liveness` and `/_readiness`;
  - exactly one intended community for the host;
  - unknown-host rejection;
  - owner authentication and owner role;
  - rejection of an unprovisioned human;
  - invite admission of a second human only to this relay;
  - valid owner-signed NIP-OA managed-agent admission;
  - missing/invalid agent delegation rejection;
  - message/media persistence after relay restart.
- [ ] Point to `crates/buzz-cli/TESTING.md` and the existing operator/member commands rather than inventing new endpoints.
- [ ] Require secrets and signed events to be redacted from screenshots and logs.

### Step 3: Define packaged-app evidence without risking the user's main profile

- [ ] Require a clean macOS test account, test machine, or separately identified canary bundle.
- [ ] Explicitly forbid wiping the user's normal app data as a test shortcut.
- [ ] Require screenshots/logs proving:
  - no Builderlab browser login or community chooser;
  - relay-local profile/welcome then chat;
  - human message send/receive;
  - managed agent creation or restore;
  - agent runtime starts without the current missing-private-key error;
  - agent responds in chat;
  - desktop restart preserves the same human pubkey, relay, and agent pubkey;
  - relay restart preserves membership, messages, media, and agent authorization.

### Step 4: Add the operational proof-state template

- [ ] End the runbook with:

```markdown
## Release Evidence

| State | Result | Evidence |
| --- | --- | --- |
| Implemented | pass/fail | commit SHA and changed files |
| Locally tested | pass/fail | contract, unit, and E2E commands |
| Packaged | pass/fail | artifact path, version, embedded relay |
| Deployed | pass/fail | image digest, public host, health checks |
| Live-proven | pass/fail | fresh-install, chat, agent, restart evidence |
```

### Step 5: Replace the Compose README's future-tense bootstrap

- [ ] Change the quick start to:

```bash
cd deploy/compose
./bootstrap.sh \
  --domain "${OWNED_DOMAIN:?Set the approved public relay domain}" \
  --owner-pubkey "${OWNER_PUBKEY:?Set the approved owner public key}"
./run.sh config
./run.sh start
```

- [ ] Remove wording that the bootstrap may generate an owner keypair.
- [ ] Link to `docs/operations/owned-relay-runbook.md` for public-host and packaged-app validation.
- [ ] Keep the manual `.env.example` route documented as an advanced/recovery option.

### Step 6: Review and commit the runbook

- [ ] Verify all referenced paths and command names:

```bash
test -f crates/buzz-cli/TESTING.md
test -f deploy/compose/compose.caddy.yml
just --list | rg "desktop-owned-build|owned-distribution-contract"
git diff --check
```

- [ ] Commit:

```bash
. ./bin/activate-hermit
git add docs/operations/owned-relay-runbook.md deploy/compose/README.md
git commit -s -m "docs: add owned relay operations runbook"
```

## Task 5: Run the Local Quality Gate

**Files:**

- Verify all changed files from Tasks 1–4.
- Modify only files implicated by a failing check.

### Step 1: Run fast contracts and syntax checks

- [ ] Run:

```bash
bash -n \
  scripts/build-owned-desktop.sh \
  scripts/test-owned-desktop-build-contract.sh \
  deploy/compose/bootstrap.sh \
  deploy/compose/test-bootstrap.sh \
  deploy/compose/run.sh
just owned-distribution-contract
```

Expected: both shell contracts pass.

### Step 2: Prove the existing compiled configuration boundary

- [ ] Activate Hermit and run:

```bash
. ./bin/activate-hermit
just desktop-tauri-test-compiled-flags
```

Expected: both clean and auto-connect compiled states are verified.

### Step 3: Run desktop unit and focused integration proof

- [ ] Run:

```bash
cd desktop
pnpm test
pnpm build:e2e
pnpm exec playwright test tests/e2e/onboarding.spec.ts --project=integration
```

Expected: unit tests and the onboarding integration spec pass.

### Step 4: Run the repository gate

- [ ] From the repository root:

```bash
. ./bin/activate-hermit
just check
git diff --check
git status --short
```

Expected:

- all checks pass;
- no whitespace errors;
- only intentional changes are present;
- `.codegraph/` remains untouched and untracked.

### Step 5: Correct failures narrowly

- [ ] If a check fails, record the exact failure, fix only the implicated code, and rerun the smallest failing command before rerunning the full gate.
- [ ] Do not weaken URL, membership, private-key, or host-isolation assertions to make a test pass.
- [ ] If corrections changed tracked files after the task commits, make one DCO-signed fix commit:

```bash
. ./bin/activate-hermit
git add <only-the-corrected-files>
git commit -s -m "fix: satisfy owned relay bootstrap gate"
```

## Task 6: Deploy and Prove the Owned Relay

**Files:**

- Use: `deploy/compose/bootstrap.sh`
- Use: `deploy/compose/run.sh`
- Use: `docs/operations/owned-relay-runbook.md`
- Do not commit: `deploy/compose/.env`, certificates, keys, tokens, database dumps, or production logs.

### Step 1: Stop at the external-authority gate

- [ ] Obtain explicit user approval for:
  - the production origin host/provider and recurring cost;
  - the public company domain;
  - the stable owner Nostr public key;
  - DNS/TLS changes;
  - the image tag or digest to deploy;
  - who controls backup storage.
- [ ] Do not infer these values and do not create paid infrastructure without approval.

### Step 2: Bootstrap and inspect configuration

- [ ] On the approved host, generate `.env` using the runbook.
- [ ] Replace the pre-release image with the approved immutable image.
- [ ] Back up `.env` to the approved encrypted secret store before first start.
- [ ] Run:

```bash
BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh config
```

Expected: Compose renders successfully, no `CHANGE_ME` appears, the public host is consistent across relay/media/CORS settings, and membership plus NIP-OA remain enabled.

### Step 3: Deploy and prove health

- [ ] Start the stack and capture redacted evidence:

```bash
BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh start
curl -fsS "https://${OWNED_DOMAIN}/_liveness"
curl -fsS "https://${OWNED_DOMAIN}/_readiness"
./deploy/compose/run.sh status
./deploy/compose/run.sh list-members
```

- [ ] Confirm the configured owner appears with owner authority.
- [ ] Confirm the WebSocket endpoint accepts a NIP-42 exchange through `wss://${OWNED_DOMAIN}`.

### Step 4: Prove security and tenancy faults

- [ ] Exercise the public hostname and an unknown `Host` value; the unknown host must fail closed.
- [ ] Attempt authentication with an unprovisioned human public key; it must be rejected.
- [ ] Invite one test human, prove admission, and prove it does not create or access another host-bound community.
- [ ] Start a managed test agent with a valid owner-signed NIP-OA tag; it must authenticate.
- [ ] Retry with the tag missing and with a tampered tag; both must be rejected.

### Step 5: Prove persistence and rollback readiness

- [ ] Create a test channel, message, media attachment, and agent identity.
- [ ] Run the non-destructive relay restart:

```bash
BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh restart
```

- [ ] Recheck health and confirm membership, message, media, and agent authorization persist.
- [ ] Run `./deploy/compose/run.sh backup-hint` and complete the approved backup procedure.
- [ ] Record the previous image digest and exact rollback command without deleting volumes.

## Task 7: Build and Live-Prove the Packaged Desktop

**Files:**

- Use: `scripts/build-owned-desktop.sh`
- Use: generated Tauri artifacts under `desktop/src-tauri/target/<target>/release/bundle/`
- Do not change the user's normal app data or keyring entries.

### Step 1: Produce the owned package

- [ ] From a clean checkout of the proven commit, run:

```bash
. ./bin/activate-hermit
just desktop-owned-build "wss://${OWNED_DOMAIN}"
```

- [ ] Record:
  - source commit SHA;
  - target triple;
  - artifact path and checksum;
  - app version;
  - reviewed embedded relay URL;
  - whether the package is unsigned, signed, or notarized.

### Step 2: Fresh-install proof

- [ ] Install in the approved isolated environment.
- [ ] Capture the first-run command/network evidence.
- [ ] Prove:
  - exactly one owned community is created;
  - no Builderlab command or browser login occurs;
  - no community chooser is presented;
  - the relay-local profile/welcome flow reaches chat;
  - the human public key matches the approved test identity;
  - no private key is present in localStorage.

### Step 3: Chat and agent proof

- [ ] Send and receive a human message through the public relay.
- [ ] Create or restore a managed agent.
- [ ] Start the agent and inspect the harness status.
- [ ] If startup fails, use the harness log and keyring diagnostics to identify the exact missing key/provider/command boundary before changing code.
- [ ] Send the agent a chat instruction and receive its response in the same thread.
- [ ] Capture redacted screenshots of chat, agent runtime status, and the response.

### Step 4: Restart proof

- [ ] Record the human pubkey, active relay URL, and agent pubkey.
- [ ] Quit and relaunch the packaged desktop.
- [ ] Confirm all three identifiers are unchanged.
- [ ] Start the same agent again and receive another chat response.
- [ ] Confirm Builderlab remains uninvolved.

### Step 5: Report the proof states separately

- [ ] Fill the runbook's release-evidence table.
- [ ] Mark `live-proven` as pass only when the packaged fresh-install, chat, agent, and restart checks all pass against the public host.
- [ ] If an infrastructure credential, signing identity, or paid-host decision blocks the remaining gate, report that dependency without calling the release complete.

## Completion Criteria

- The owned build and Compose bootstrap contracts are versioned and run under `just check`.
- The existing desktop auto-connect path is regression-tested for no Builderlab invocation and no private-key persistence.
- Builderlab's explicit hosted-community tests still pass.
- The deployment runbook contains no secret values and separates local, packaged, deployed, and live proof.
- The public relay passes health, host isolation, membership, agent delegation, and restart persistence checks.
- A fresh packaged app completes chat and managed-agent work against that relay without Builderlab.
- Branding and consumer-facing Buzz-to-AI-Native-Office terminology remain deferred to their own approved phase.
