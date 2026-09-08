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

Root reviewed desktop and narrow light/dark renderings. Five distinct screenshots
and their hashes are retained in
`/private/tmp/colony-first-job-starters-reviewed-screenshots/manifest.json`.
The desktop view retains the production reading font, communities rail, accent
surfaces and adjacent panes. At 360px, ordinary scrolling reaches the Start
button without shrinking the reading font or overflowing horizontally.

Independent review found one issue: React Query retains old data after a failed
refresh. The hook now requires a successful query as well as allowed access;
the browser gate covers failure and recovery. Final independent review found no
remaining actionable issue in the prompt/UI/access slice.

## Full repository gate

`CARGO_BUILD_JOBS=2 just ci` exited 0 on the frozen source. It passed 7,062 desktop
tests (zero failures/skips), 2,937 native primary tests (25 existing ignored),
967 mobile tests (one existing skip), Rust formatting/lint/tests, desktop/native
checks and desktop/web builds. Full log:
`/private/tmp/colony-first-job-starters-final-ci.log`.
The preceding run stopped at formatting in the browser test while it was still
being edited; that log is retained as
`/private/tmp/colony-first-job-starters-final-ci-format-red.log`. The full gate
was rerun after the final source/test freeze.

## Remaining gates

The joined native run with the untouched five-pair default,
follow-up PR/merge and a normal beta on that final source remain separate gates.
PR #660 and its normal beta predate these starter additions; their successful
font/rail/native-handoff checks do not substitute for this follow-up's proof.
