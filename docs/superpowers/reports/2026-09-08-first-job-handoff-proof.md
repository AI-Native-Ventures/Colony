# Onboarding first-job handoff: proof ledger

## Scope and current gate

This completes the explicit first-job subsection of the approved
[onboarding design](../specs/2026-09-08-simple-founder-onboarding-design.md).
The visual redesign itself merged in [PR #655](https://github.com/AI-Native-Ventures/Colony/pull/655)
at `a2c8149f4a22a3ed4ae250cde380e65604583626`. Its reviewed screenshots and
existing beta remain separate evidence; this follow-up does not introduce a
social publishing workflow or replace Colony's channel/right-thread layout.

The final production source passed the full local repository gate (`just ci`,
exit 0), independent review and rendered font/rail/width checks. Native run 26
passed the joined account, recovery, business and first-work gate on the final
immutable fixture package. Both cards displayed Completed before reload and
recovered the same completed Task after reload in 6.1 seconds, without another
agent turn. Real message text used loaded regular Inter at 14px/400 weight, and
the far-left community rail was visible.

The workspace retains the approved spacing, gradients and panes while restoring
production's reading font and community navigation from the first business.
External CI, merge and a normal beta remain separate delivery gates; the package
below is the explicitly named debug fixture, not the distributable beta.

## Resulting behaviour

Account and business setup open one owner-authored Setup suggestion in Welcome.
The owner can edit its brief and explicitly start it. Both visible copies in the
channel and thread share the same draft, pending action and outcome. Setup no
longer sends an invented paid instruction or authors an agent's claim that work
has started.

Start checks supported configuration, exact available credits, the existing
approved company setup and approved coordinator/worker. Missing funding or
staffing remains visible without creating a Task or starting a model turn.
Fresh businesses currently have only their Chief of Staff; this change does
not silently approve an operating profile or hire a worker.

The existing native Task attachment and relay receipts record the work before
runtime launches. Both captured processes must report listening/ready before
the owner instruction is signed and published. Scout receives the instruction,
delegates through existing agent tools and remains accountable for review.
The card displays the actual canonical Task status. Send acceptance alone is
not completion.

Draft, checkout and dispatch state are scoped to the owner, relay, channel,
thread root and request. Cross-window locks protect local effects; the relay's
existing claim key arbitrates devices. A persisted random nonce binds each
device's complete brief and actors to its exact signed action. A losing device
does not send another instruction. Unknown results preserve the original
action/message rather than minting a replacement.

Applied receipts are recovered before retrying old actions. Only an exact
relay-signed refusal permits preparation of a new revision on another explicit
click. An unconfirmed saved instruction older than the receiver's startup
lookback is retained for thread review, not silently replayed as new work.
The latest canonical Task is also rechecked before launches and after readiness;
cancellation, completion, reassignment or changed work scope prevents the saved
instruction from executing. An acknowledged request remains read-only.

Funding uses the existing prices, checkout and balance service. Checkout return
verifies the saved reference and actual available funds; it offers Start again
instead of beginning paid work automatically. Unknown balance is an error,
not a zero balance. Existing own-key configuration remains supported.

## Local verification

| Gate | Observed result |
| --- | --- |
| Final repository `CARGO_BUILD_JOBS=2 just ci` | Exit 0 with the final font, rail, width and live-status changes; `/private/tmp/colony-first-job-final-ci-complete.log` |
| Desktop tests in that full gate | 7,056 passed, zero failures/skips, including shell-result, Task-head and live-refresh cases |
| Fixture tool-result parser | Three focused tests passed, including exact current call identity and failed/timed-out commands; included in the final default suite |
| Explicit real Chromium transport integration | One passed after test classification; `/private/tmp/colony-proxy-classification-green-chromium.log` |
| Native desktop primary suite | 2,937 passed, 25 existing ignored environment/performance tests |
| Mobile suite | 967 passed, one existing skip |
| Other repository gates | Root Rust formatting/clippy/unit suites, desktop lint/type/native inventory/boundaries/file size, native build/checks and web build passed |
| Live Task refresh | Seven passed, including two mounted panes and reconnect cleanup; `/private/tmp/colony-task-live-updates-final.log` |
| Focused final handoff regressions | 173 passed; `/private/tmp/colony-first-job-all-focused.log` |
| Actual renderer browser handoff | Seven passed against the reviewed E2E build; `/private/tmp/colony-first-job-reviewed-browser.log` |
| Task-head fixture regression | Four passed after a failing control; historical revisions retain one logical Task, genuine duplicate IDs and forged/misbound heads are rejected |
| Final ACP fixture propagation | Isolated subprocess red/green, 15 default MCP tests, both default and feature all-target clippy with warnings denied and scoped formatting passed |
| Fixture transport | Separate native/default-feature, CLI/ACP request, Chromium allowlist and wrong-key negative checks; fixture-only configuration is absent from normal packaging |

Browser tests use synthetic native/relay/payment responses. They prove shared
pane edits, explicit zero-credit blocking, unknown-balance errors, missing
business/team, checkout return, recovered exact instruction and narrow
light/dark presentation. They do not prove account registration, payment
settlement, worker execution or output quality.

Regressions were observed failing before fixes for native scope changes,
read-only attachment, runtime readiness, failed-worker short circuit,
cross-device action identity, exact refusals, delayed instruction signing,
expired saved delivery, applied-receipt recovery and scoped payment/publication.
The final source restores all guards and passes the focused and full gates.

A final review then found that a saved Task receipt could outlive cancellation
or reassignment during a failed runtime start. Two failing-before/passing-after
dispatch checks and the actual adapter validator now cover the current-head
recheck. The combined dispatch/validator slice passes 31 tests. Independent final review found no remaining blocker in the current Task
validation, scoped retry/payment path or CI test placement. The final
renderer, full source gate and separately named fixture package were then
rebuilt and passed; their results above include that correction.

The browser transport test initially lived in the default Node unit glob,
although Desktop Core does not install Chromium. An empty browser-cache
reproduction failed at the missing executable while the pure proxy test passed.
The integration test now runs as an explicit command after Chromium installation
in smoke shard 1. The full default Node suite and the explicit integration both
pass after the move. This changes test placement, not the assertions or
application artifact.

### Final full-suite timing failure

The next full repository run passed Rust/native checks and all 7,056 desktop
tests, but the unchanged mobile applied-receipt test failed. The same full mobile
suite failed on the clean baseline too. Its fake relay pre-signed an action,
then the client signed it again; crossing a Unix second produced another event
ID and made the prepared receipt belong to an event the client never sent.
An isolated 1.1-second boundary control reproduced the failure.

The test-only fake relay now answers the actual published signed action. The
refusal case also checks the refusal message, preventing a timeout from passing
as an expected rejection. No mobile production code or deadline changed. The
forced boundary control then passed, the focused file passed nine tests, and the
full mobile suite passed 967 tests with its one existing skip. Evidence:
`/private/tmp/colony-first-job-mobile-baseline-suite.log`,
`/private/tmp/colony-first-job-mobile-boundary-red.log` and
`/private/tmp/colony-first-job-mobile-final-suite.log`. The subsequent full
repository run also completed with exit 0 and all 967 mobile tests passing. Its
log is `/private/tmp/colony-first-job-final-ci-complete.log`.

### Font and community rail acceptance

The user's production comparison exposed the redesign's workspace-wide Inter
Tight override. Removing it restores the existing Inter Variable stack across
messages, inline work and composers while preserving onboarding's own branding.
The community rail now stays available with one community. Existing switching,
reordering, add-community and macOS chrome checks pass. Both changes failed their
new rendered assertions against the earlier immutable build.

A strict 360-pixel outer-bounds check also found the outer sidebar container's
intrinsic minimum width pushed the thread beyond the viewport after the rail was
restored. The correction lets that container shrink; it does not reduce the
message font or desktop split-pane minimums. Narrow proof checks actual panel
bounds and user scrolling to the Start action, rather than requiring a whole
long message to fit in one screen.

The fresh browser run passed 36 font, rail and handoff cases before the two
360-pixel bounds failures exposed that issue. After the container fix, all four
focused final cases passed against a new immutable E2E build: long prose and
inline work, shared zero-credit state, and narrow light/dark thread views. The
source manifest confirms the container minimum width was the only intervening
production change. Logs are `/private/tmp/colony-font-rail-green.log` and
`/private/tmp/colony-font-rail-final-green.log`; screenshots and hashes are in
`/private/tmp/colony-font-rail-final-proof`. The frozen index digest is
`4e39a8ec5f05cb52a65bc1b507e9b38f94aed119f43383c64132aaaff55dd5e0`.

## Joined native fixture boundary

`desktop/src-electron/onboarding-smoke.mjs --with-work` runs a separately named
Colony Onboarding Fixture app. Its nondefault compile-time feature maps exact
canonical `.invalid` tenant hosts to unique local services. Real native crypto,
encrypted recovery persistence, HTTP/NIP-98 signatures, provisioning, channel
membership, signed Tasks, isolated ACP processes and CLI tools remain in use.
Only the isolated service environment, recovery save destination and deterministic
provider replies are fixtures. System DNS, system certificate trust, hosted
accounts, payment providers and personal browser sessions are untouched.

Native HTTP/WebSocket clients validate the process-private CA and hostname.
Chromium uses a fixture-key SPKI exception, which bypasses certificate validation
for that key; it is not proof of normal Chromium CA validation. Separate checks
enforce host/URL restrictions, native CA validation and a wrong-SPKI failure.
Literal-IP traps receive no accepted requests.

The successful work precondition must explicitly approve the company profile,
team and worker through real owner CLI/native APIs. Test credits come from the
existing admin ledger seed command in the unique database. Neither is a new
production default or proof of checkout settlement. Deterministic provider
responses test delegation/tool execution and review, not model quality.

The reviewed fixture archive is
`7cc6270f77def44877f1e74ad8bc47a5c6a3f71ef1f2bace6fa6792a172a8d47`,
with native host
`c55e91f2e92e79f80a4558919d92e3b8ab08b8087ed48fd3c01ed6ea08ef86f0`
and ACP helper
`e7ddf640ca2f15c46e7406019905f736f72e2c7161093762c6321aa132f8bffd`.
After packaging and signature verification, root independently rehashed all
seven bundled native executables and checked their sizes/digests against the
manifest. The byte proof is
`/private/tmp/colony-first-job-fixture-final-width-byte-proof.json`.
Every run records package/helper/script hashes and public evidence, preserves
failure diagnostics without credentials, and cleans its owned processes,
Compose volumes, unique profile and Keychain service.

### Failures corrected in the test harness

- The debug account path performs two serial password derivations; its driver
  needed to wait for the actual operations rather than time out prematurely.
  Production derivation cost and per-operation limits remain unchanged.
- Deeply nested temporary paths exceeded the Unix socket path limit. The
  fixture uses a short temporary directory and retains normal OS HOME so its
  unique Keychain service works. It never reads a user's agent credentials.
- Kind 40013 action verification requires an exact authenticated relay query;
  the native `get_event` allowlist does not include that kind.
- An open test relay does not publish the owner-membership snapshot used by
  approval validation. The fixture now uses the checked-in production membership
  and owner-attestation policies, with a separate synthetic bootstrap operator.
  Production owner/team validation was not relaxed.
- The isolated launcher resolves a direct provider destination even when its
  actual requests use the provisioned credits gateway. The fixture correctly
  rejected that unused public destination. Like the existing managed-agent
  smoke test, this gate explicitly configures both synthetic agents' supported
  `OPENAI_COMPAT_BASE_URL` to their exact business gateway. Actual requests must
  still use provisioned tokens and the meter/gateway. This qualifies the proof:
  it does not exercise an untouched default direct-provider address. The normal
  launcher's extra vendor DNS dependency is unchanged.

- The model fixture initially looked for CLI acceptance in an unparsed MCP
  shell response. It now parses the exact issued tool call's wrapper and stdout,
  requires a successful non-timeout exit and actual relay acceptance, and cannot
  reuse an earlier command's success. Three focused regression checks pass.
- The native run then reached a real Scout tool call and exposed the MCP child's
  deliberate environment clearing. The nondefault ACP fixture feature now puts
  only its validated public transport configuration into the declared dev-MCP
  environment. It preserves identity entries, does not alter browser settings,
  and leaves the default environment allowlist unchanged. An isolated subprocess
  regression failed before the fix and passes with valid configuration crossing
  the cleared environment and missing/malformed configuration refused.
- The driver now reloads the renderer once and restores the Welcome hash only
  if the actual channel/root changed. It retains default relay quotas and permits
  one explicit UI retry only after the exact bounded server cooldown, with no
  prior instruction or model work and no expired signed instruction.
- Independent final fixture review checked the positive-funds/no-worker sequence,
  exact CLI result parsing, scoped retry, read-only diagnostics and cleanup. It
  caught and corrected a selector that expected a status label where the real
  blocked-state UI renders an alert. No product guard was weakened.

### Native gate traffic

A later run reached a real Task and instruction, then the fixture's signed Task
read received HTTP 429 before it could supply a model response. The relay's
existing admission policy is 300 calls per minute per human principal and tenant.
The aggregate proxy log did not identify which caller produced every query, so
it does not establish that all traffic came from the test observer.

The revised gate counts its own helper HTTP calls, waits one admission window
before Start with no saved attempt/model work, and observes persisted Task status
using a scoped read-only SQL query every two seconds. Agent commands and final
completion still verify the actual current relay-signed Task head. This removes
avoidable observer traffic without raising quotas, inserting work state or
retrying a model request after execution has begun.

A subsequent run produced all four accepted CLI operations (delegation, worker
output, review and completion report) and a persisted completed status. Its
final test incorrectly counted historical signed Task revisions as separate
Tasks. The corrected inspector matches the production repository's newest-head
ordering, verifies every signature and address, and separately requires one
logical Task ID. It preserves public candidate metadata for failed assertions.
Four focused tests distinguish valid revisions from genuine duplicate Tasks or
forged/misbound heads. Native run 21 then passed the complete joined gate with
one logical Task, all four accepted CLI operations, ten deterministic model
responses and no additional work after reload. Its proof JSON is
`/private/tmp/colony-first-job-joined-proof-21/account-proof.json` (SHA-256
`fea6cfbd78c576456084a47db9b40b77c68b5f20886e2f99a5730236e324e283`).
Cleanup completed and the owned worker/coordinator processes were absent.

### Live completion status

The run-21 screenshots distinguished persisted completion from live status: the
Task was completed, but the two visible suggestion cards changed from In progress
to Completed only after reload. The existing canonical Task query had a stale
time but no remote-event invalidation; stale time alone does not trigger a read.
Native run 23 reproduced this without reloading: one logical Task was completed,
all four CLI operations succeeded, and the card still showed In progress for the
entire 30-second assertion. Its owned processes and isolated services were cleaned.

The fix subscribes to the current relay's authoritative Task heads and refreshes
the existing shared query for both visible panes. Seven focused tests pass,
including two mounted real `useTask` consumers, signed-head validation, shared
subscription cleanup, stale scope rejection and a reconnect/in-flight refresh
race. The missing subscription and reconnect race each had a failing control.
Evidence is `/private/tmp/colony-task-live-updates-final.log`. Native run 25 on
the revised package then showed Completed in both panes before reload, with ten
provider responses and all four accepted CLI operations. It also verified loaded
regular Inter, the computed message font and the visible community rail. The
saved screenshot is
`/private/tmp/colony-first-job-joined-proof-25/joined-worker-reviewed.png`.

That run failed only the post-reload status assertion: the persisted brief
returned, but the asynchronous canonical read had not produced Completed within
the test framework default of five seconds. The final signed head still named
one completed Task. This establishes the live fix, not the duration or cause of
post-reload loading. The next unchanged-package run uses the same explicit
30-second bound for both live and post-reload cards, records elapsed UI status
observations, and still requires the same Task with no additional work.

One presentation limitation remains: the generated instruction includes a raw
Nostr worker identity. The existing Markdown renderer does not support a working
Nostr profile link, so a masked link would create a misleading dead anchor. This
change preserves the correct agent reference instead of adding new link handling
or hiding routing information in Markdown tricks.

### Final package account-preparation retry

Native run 24 used the rebuilt font/rail/live-status package while the full
repository gate was also running. It stopped during local account preparation,
before any relay HTTP request, account creation, Task or model call. The UI
reported that the account could not be prepared securely; the original native
error was not exposed. CPU contention is only a possible explanation, not a
confirmed cause. Cleanup completed. The next run uses the same immutable package
after the full gate exits, with the existing crypto and timeout bounds unchanged
and bounded, sanitized failure diagnostics. Evidence is
`/private/tmp/colony-first-job-joined-proof-24/account-proof.json`. The passive
helper retains only fixed error categories; pending recovery state is reduced
to phase and presence/owner-match booleans inside the renderer. Two focused
privacy/bounds/cleanup checks pass. No raw diagnostic error or recovery secret is
retained, and the immutable app is unchanged. Run 25 then passed account
registration, recovery after relaunch, recovery export/acknowledgement and business
provisioning on the same package after the full gate stopped. This establishes
the path works in that run; it does not establish the cause of run 24.

## Final joined result

Native run 26 completed with exit 0 and cleanup complete. Its proof JSON is
`/private/tmp/colony-first-job-joined-proof-26/account-proof.json` (SHA-256
`582b0b32c68feeaa8b9080139cb5802465d8cc534d17ff34d0e9aa9392e05995`).
It proves account/recovery/business setup, zero-credit and funded/no-worker
blocks without work effects, explicit approved staffing, two isolated native
agents, four accepted CLI operations, ten gateway model responses and one minted
runtime token. Exactly one instruction and one logical completed Task remained.
No quota retry was needed and reload caused no extra model turn.

Both cards were Completed live before reload. After reload, UI-only observations
showed Task sent at 1,217ms and Completed in both panes at 6,098ms; the assertion
finished at 6,099ms. This explains why run 25's five-second observation ended too
early, without changing any product timeout or implementation. The ordinary
history request can itself wait up to 25 seconds. The restored message font is
loaded Inter Variable, 14px, weight 400; the community rail is visible. Reviewed
screenshots cover the missing-worker block, real worker/review output and both
completed cards after reload. The proof helper's later passive diagnostics add
two focused privacy/bounds/cleanup tests to the source checked by the full gate.

## Remaining delivery gates

Local implementation, independent review, rendered acceptance and the joined
native fixture are complete at this source checkpoint. The PR must publish the
reviewed screenshots, pass actual GitHub checks and merge into develop. A normal
beta with the fixture feature disabled must then pass its packaged checks and
produce a downloadable artifact. Delivery status belongs to the PR/run evidence.

Hosted signup, real checkout settlement, autonomous model quality, production
promotion, notarization and updater publication are not claimed by these gates.
