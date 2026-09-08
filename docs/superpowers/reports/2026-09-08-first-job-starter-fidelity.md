# First-job starter fidelity follow-up

The approved onboarding preview and design specify five Instagram captions and
five matching visual briefs, with a potential-client example when Discovery is
available. The initial handoff implementation used a generic three-improvement
brief. This follow-up restores the approved examples within the existing Setup
suggestion, editable brief and explicit Start action.

## Acceptance boundary

- Fresh setup suggests five caption drafts and five matching written visual
  briefs for the owner's business. Selecting an example only edits the draft.
- Both channel and right-hand thread show the same selection and edits. A custom
  brief survives a renderer reload and loses any inaccurate predefined output
  description. Existing saved or submitted briefs are not migrated.
- Discovery is offered only after the existing relay capability and current
  account/business entitlement checks succeed. Unsupported, unknown and failed
  refreshes hide that optional example without blocking the default.
- Choice controls disappear once the existing dispatch locks the brief. Credit,
  staffing, Task, signing and runtime checks remain the handoff's existing ones.
- The joined native fixture must use the actual untouched owner-signed default,
  delegate it through real isolated agents, render all five caption/visual-brief
  pairs and recover one completed Task with no extra turn after reload.
- The restored regular message font, far-left communities rail, coordinated
  accents, channel/right-thread layout and narrow-screen scrolling remain intact.

This is prompt selection and presentation, not a social publishing workflow.
The fixture supplies deterministic model responses; it proves the app's real
handoff and rendering path, not autonomous content quality or live Discovery
results. No images are generated or posts published by selecting a starter.

## Verified source and rendered gates

The prior default failed the five-caption assertion before the model change.
The updated prompt model and founder-brief suite passed 13 focused tests. The
old rendered app also failed the new expected-output browser assertion, as
intended. The final frozen E2E renderer has index SHA-256
`1589037c0e9fcb726d1cd05a322fb796615f79c4a7b29e6279d07c6c91edecbc`.
All 2,790 renderer/public source hashes were rechecked after the last browser run,
with no differences. Its manifest is
`/private/tmp/colony-first-job-starters-final-e2e-manifest.json`.

Eight distinct browser cases passed: seven in the final suite and the corrected
reload case in a focused run (6.1 seconds). Logs are
`/private/tmp/colony-first-job-starters-final-browser-green.log` and
`/private/tmp/colony-first-job-starters-final-reload-hover-green.log`.
The first suite exposed a test-only reload race: its in-memory relay lost the
Welcome channel, and a second raw hash navigation raced channel restoration.
The test now restores only the mock relay channel/root, waits for the real saved
brief, and uses the existing hover-then-Reply action. It never rewrites the saved
draft. The final case verifies account/business-key separation and allowed →
failed access refresh → allowed recovery, in addition to zero Task/runtime/Start
effects and matching custom drafts after reload.

Root reviewed desktop and narrow light/dark renderings. Nine distinct browser
and native screenshots and their hashes are retained in
`/private/tmp/colony-first-job-starters-reviewed-screenshots/manifest.json`.
The desktop view retains the production reading font, communities rail, accent
surfaces and adjacent panes. At 360px, ordinary scrolling reaches the Start
button without shrinking the reading font or overflowing horizontally.

Independent review found one issue: React Query retains old data after a failed
refresh. The hook now requires a successful query as well as allowed access;
the browser gate covers failure and recovery. Final independent review found no
remaining actionable issue in the prompt/UI/access slice.

## Earlier repository gate and final CI policy

`CARGO_BUILD_JOBS=2 just ci` exited 0 on the earlier frozen starter source
committed as `41f1ae5704`, before the readable-reference follow-up. It passed 7,062 desktop
tests (zero failures/skips), 2,937 native primary tests (25 existing ignored),
967 mobile tests (one existing skip), Rust formatting/lint/tests, desktop/native
checks and desktop/web builds. Full log:
`/private/tmp/colony-first-job-starters-final-ci.log`.
The preceding run stopped at formatting in the browser test while it was still
being edited; that log is retained as
`/private/tmp/colony-first-job-starters-final-ci-format-red.log`. The full gate
was rerun after the final source/test freeze.

## Joined native gate

Native run 27 passed on signed source
`41f1ae57048c302e82ddb4207cf99f9face4507f`, with no source changes during the run.
Its separately named debug fixture package has ASAR SHA-256
`b6f7d18faf80c8bed23c67e56ec9f3efaa382bc5514bab664eee7071069fc27d`
and native-host SHA-256
`a9ea7efadec9cdef6426fc8a350083051fc31e0b6a06c57536fe7c562983e501`.
All seven native file sizes/hashes and the ad-hoc signature were verified;
`/private/tmp/colony-first-job-starters-package-byte-proof.json` records the
complete package/source relationship.

The real account/recovery/relaunch and business provisioning path produced the
untouched five-pair default in the owner-signed root and both panes before any
edit. Zero credits and funded/no-worker conditions produced no work. After
explicit fixture-owner approval and Start, isolated Scout and Sarah processes
performed four accepted CLI operations using ten deterministic gateway responses
and one runtime token. All five distinct captions and their five matching visual
briefs were asserted in the actual rendered worker message; Scout received every
field for review. Exactly one instruction and one logical Task remained.

Both panes displayed Completed before reload, with loaded regular Inter Variable
at 14px/400 and the far-left communities rail visible. After reload, the same Task
returned to Completed in both panes in 6,131ms with no extra model turn. There
were no quota retries. Owned agent PIDs, containers, volumes and the isolated
profile were independently confirmed removed.

Proof: `/private/tmp/colony-first-job-joined-proof-27/account-proof.json`, SHA-256
`32e4bbca82dd515fcb4392c6e29f0912e48bc3f61fb10b3ea73c4350fd07e24c`.
Root and the native worker inspected the returned-work and completed-after-reload
screenshots; they are distinct and retained with the browser screenshots.
This is real packaged control flow with deterministic model replies, not a claim
about autonomous content quality, generated images or published posts.

## Readable worker reference follow-up

Final visual audit found that the signed owner instruction still exposed a raw
`nostr:npub` identity. This was production-authored text, not just missing fixture
profile metadata: the existing Markdown mention renderer recognizes friendly
`@name` aliases but does not rewrite raw Nostr URIs. The new preparation step
reads the selected managed worker's current name in the captured business scope
and snapshots it into the immutable signed instruction. Existing identity tags
remain authoritative; the worker remains a non-notifying reference and only
Scout is pinged. Missing or malformed names use a readable generic reference.
No new profile-link mechanism, team identity field or dispatch path is added.

The unchanged rendered app failed the new friendly-name assertion before the
fix. Fifty-two focused message/preparation/dispatch checks then passed, including
same-business name resolution, non-notifying worker tags, malformed-name fallback
and scope changes. The actual React case then passed, showing Sarah's agent chip,
no raw identity and exactly one recovered instruction without additional runtime
starts. TypeScript and scoped Biome passed. The independently reviewed frozen
renderer has index SHA-256
`aa3970111933be859f6180302aa80c399bca967bdbdbdfeb6d78d460c1c0eb78`;
all 2,790 renderer/public source hashes match its manifest at
`/private/tmp/colony-worker-name-e2e-manifest.json`. Red and green logs are
`/private/tmp/colony-worker-name-browser-red.log` and
`/private/tmp/colony-worker-name-browser-green.log`. Root inspected the dedicated
friendly-reference capture. Native run 28 then passed on the frozen tree based on signed `41f1ae5704`
plus this reviewed delta. It is not presented as a clean build of `41f1ae5704`.
Its package/source record is
`/private/tmp/colony-worker-name-package-byte-proof.json`, with ASAR SHA-256
`644f559b202a7a2c39d1dcf1ac7d3c5768367d4460a17173c3f0e7f856271f28`
and source-diff SHA-256
`c04eff4a1200f3f9d545ae61f7f918bf8f9adb73de6b8e452478fbb935e2696c`.
All seven native binaries, the ad-hoc signature and frozen renderer hashes were
verified before execution.

The real owner-signed instruction displayed Sarah's agent chip and retained
exactly the Scout notification tag plus the worker's non-notifying reference.
Its signature was independently verified from fresh wire fields. The unchanged
five-pair default, account/recovery/business path, zero-credit and missing-worker
blocks, all ten rendered output fields, four accepted CLI operations, two
isolated agents, one instruction and one Task all passed again. Both panes
completed live and recovered the same completed Task in 6,017ms after reload,
without another model turn. Loaded regular Inter at 14px/400 and the visible
communities rail passed in this package too.

The final proof is
`/private/tmp/colony-first-job-joined-proof-28/account-proof.json`, SHA-256
`c04c0c6b74afe7e811a908ddbaab017b45ff781784edee4dc82c22f1fb93f707`.
Native run 27 remains a separate historical checkpoint. Root inspected the
actual friendly-reference screenshot; the new package's output, reload and
friendly-reference captures replace only the current review copies. Independent
cleanup verified the two agent PIDs absent, zero owned containers/volumes and
removal of the isolated native profile; its record is
`/private/tmp/colony-first-job-joined-proof-28/cleanup-verified.json`.

## Final validation and delivery

The readable-reference change passed focused red/green checks, actual rendered
verification, independent review and native run 28. A later full local CI run
was interrupted with exit 130 at the owner's request to use GitHub CI only.
It is not recorded as a completed final gate. No further local CI or test hooks
will run for this delivery; signed commits are preserved while commit/push hooks
are disabled per command. GitHub CI is the final repository gate.

## Remaining gates

The follow-up PR/merge and a normal beta on the final source remain separate gates.
PR #660 and its normal beta predate these starter additions; their successful
font/rail/native-handoff checks do not substitute for this follow-up's proof.
