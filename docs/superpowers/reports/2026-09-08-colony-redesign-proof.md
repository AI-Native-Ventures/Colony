# Colony redesign: implementation and verification

## Current status and correction

The approved preview remains the acceptance contract. The first real-app
screenshots attached to PR #655 did **not** pass that contract: the owner rejected
the old shell with changed colours. The earlier report's statement that the
approved design was implemented and visually accepted was incorrect. That visual
gate and its screenshots are superseded. Auto-merge was disabled while the
structure, reading layout and palette were corrected.

The corrected React build now follows the approved composition, with the actual
account/business forms, spaced sidebar, separate channel/thread frames, coordinated
palette and readable message layout. The coordinating agent compared the rendered
screens with the approved references. Browser fixtures remain synthetic. The `3e7d6104bf` beta has passed its
packaged checks and uploaded an artifact; the later CI corrections still need
their own package run. No final-revision package, merge, release, hosted signup
or live business operation is claimed here.

## Current implementation

Founder setup uses an email/password account form, a durable recovery-code
checkpoint and one business form. Sign-in, explicit key import, account recovery,
existing membership, additional-business and Welcome paths remain available.
The beta packaging source bakes the existing hosted account endpoint rather than
relying on a developer shell's relay configuration. A source/configuration repair
is not proof that an installable artifact has adopted it.

The workspace now has the Colony wordmark and existing workspace switcher in the
sidebar, a compact Inbox/Tasks/Agents/Billing menu, the existing persistent More
control for secondary destinations, and an explicit Settings action. Desktop
navigation and native window controls occupy the sidebar header instead of an
empty strip above the conversations. Collapsed/mobile layouts retain the compact
navigation row and existing access paths. No functional destination was removed.

Channel and thread are separately bordered, rounded reading panes with outer
padding and a 12px gutter. The channel remains beside the selected thread at
readable widths. An unsaved Colony thread width follows 52% of measured content
width; an explicit saved width takes precedence, and reset restores the
responsive default. Each pane reserves at least 300px. The Colony split threshold
is 612px of available content, and the drawer maximum reserves the gutter too.
Non-Colony themes retain the old 380px fallback and shared-header treatment.
The sidebar defaults to 240px, supports 185–420px resizing, and preserves stored
widths within those bounds. Existing split/focus choices and draft stores remain
in use.

The bundled Inter Tight font, normal reading weight, larger context titles,
quieter metadata, real channel/thread headers and inset composers replace the
old composition. Actual ant marks occupy the sidebar footer, away from message
text, and hide on short/mobile screens. The latest palette correction makes the
outer wash quieter and the opaque reading tint more visible. Default selected
app-sidebar rows use a quiet raised fill with readable text; unread/selected
state and the optional prominent treatment retain their existing semantics.

Soft mesh, Diagonal wash and Halo live in Settings > Appearance and persist
through the existing community preference record. The same accent supplies
frame, channel, thread, border and composer tokens. Agent identity colours remain
independent. Message headers and one-to-one agent DMs share the existing job
title and Agent label. The editor updates the existing persisted role fields;
rank, manager and execution settings retain their separate meanings. Configured
avatars are preserved; missing avatars use a stable identity-derived colour.
Inline deliverables use the existing generic Blocks renderer, with no new social
publishing workflow or hard-coded business card model.

## Current proof ledger

Mock-browser checks render the actual React components using synthetic identity,
relay, account and native-save responses. They establish rendered behaviour,
not a live hosted account signup or an agent completing a business job. Evidence
below is tied to the named source/build stage; a later edit does not inherit its
visual or package acceptance.

| Stage | Result and limit |
| --- | --- |
| Latest account/onboarding browser slice | 19 tests passed, reported by the coordinating agent; distinct from final packaged signup |
| Latest scoped source unit slice | 461 onboarding, entry and disclosure tests passed; both review fixes had failing-before/passing-after regressions |
| Corrected shell navigation and native controls | 4 More-menu tests and 3 macOS control/zoom tests passed on the structural shell build |
| Corrected workspace appearance | 2 light/dark tests passed, including pattern/accent persistence, two-pane colour response, drafts, responsive default width, drag/reset and the 860px-window fallback |
| Existing theme/Appearance suite | 21 of 22 passed on the corrected shell; the remaining test assumed the old search/header alignment and 1px/8px inset. Its intended geometry was migrated and the focused rerun passed |
| Settings, sidebar and legacy-layout follow-up | 4 passed: updated Settings frame, sidebar resize/persistence/reset, and original shared-header contract explicitly under non-Colony GitHub Light |
| Palette, selection, conversation and Appearance | 29 checks passed on the corrected build, including all 22 theme cases, agent identity, disclosure, separate drafts and split/focus behaviour |
| Final onboarding and conversation follow-up | 14 checks passed, including readable channel title, replies divider, recovery, narrow forms and two identities; subsequent changes only refine link contrast and auxiliary layout |
| Huddle compatibility | All 23 checks passed, including the previous CI failure |
| History and reading position | 18 scroll cases passed; four final checks cover both original failures, real wheel input, measured expansion/collapse, reader handoff and unread navigation |
| Final auxiliary-layout gate | All 4 appearance/layout cases passed; workspace clipping and profile minimum-width regressions were reproduced before the scoped gutter fix |
| Full repository gate | `just ci` passed: Rust fmt/clippy/unit, desktop/native/web builds and checks, 6,871 desktop tests, 2,922 native tests and 967 mobile tests. Final CSS refinements also passed fresh TypeScript, source-size and rendered-build checks |
| Final source browser gate | 12 combined onboarding/identity/conversation cases and 4 layout/appearance cases passed on the same final artifact, including long-message text contrast of at least 4.5:1 |
| Full desktop unit gate | 6,871 passed; no failures |
| Native desktop unit gate | 2,922 passed; 25 existing environment/performance cases ignored |
| Beta before the CI follow-up | `3e7d6104bf` passed packaged relocation, browser/session, signup/relaunch and isolation checks and uploaded its artifact; the final revision must run them again |
| Final repository/PR checks, merge and available beta | Pending; earlier local greens below do not satisfy these gates for the revised source |

Current shell evidence is kept outside shared runner output:

- `/private/tmp/colony-redesign-proof/shell-v3-pass/shell-proof-manifest.json`
  records the structural snapshot and eight distinct Appearance screenshot hashes.
- `shell-v3-pass/test-results/workspace-appearance/light-violet-split.png` and
  `dark-violet-split.png` show the rebuilt shell, using generic mock conversation
  content. They precede the final palette/quiet-selection correction.
- `shell-v3-followup/run.log` records the four passing follow-up checks.
- `shell-v2-red/run.log` shows the new approved-layout assertion failing on the
  previous artifact's missing wordmark.
- `shell-narrow-red/run.log` shows the 860px-window channel at 288px before the
  gutter-aware boundary repair. The corrected appearance tests pass that case.

All relative evidence paths in that list are under
`/private/tmp/colony-redesign-proof/`. The shell worker's local port 4193 and
headless browsers were stopped after verification. Local evidence paths are not
published release artifacts.

## CI follow-up after the visual correction

CI run `34227688401` on `3e7d6104bf` passed the desktop core/native,
compiled-flag, Rust and web gates, but exposed additional browser failures. Its
red result is not superseded by the local checks until the next revision's
GitHub matrix passes.

Two production corrections followed:

- A partially clipped row could lose its sender header on prepend while its
  hidden top stayed fixed, moving the first readable row. The retained anchor
  now prefers a row whose top is in view and falls back to a clipped row only
  when necessary. The unchanged stability gate measured maximum prepend drift
  of 0.36px and late-reflow drift of 0px, with no missing samples or replaced
  anchor node. The full 18-case scroll suite passed.
- At a 360px window height, the full brand header left too little room for the
  two unread controls, which overlapped. The short layout keeps the workspace
  switcher and reserves navigation space; normal windows retain the full brand
  composition. Non-native window controls receive separate clearance. The
  drop invitation also inherits its actual channel frame radius.

Other failures were test contracts that still described the old layout or did
not establish their intended state. Tests now measure the preview's available
width, the outer framed thread, the saved/requested versus clamped width, and
native chrome independently from the main reading pane. Ultrawide resizing
starts from an explicit narrow saved width and must still exceed 1200px. Hidden
font-sizing copies are excluded using the control's accessible name. Connection
screens use the existing bounded animation helper, and the long-name fixture
actually overflows the new font's metrics.

History fixtures issue real wheel input. The relay parity fixture previously
jumped over several virtualized screens between samples and stopped when the
intro was merely mounted offscreen. It now samples overlapping viewports and
requires physical top before the exhaustion exit. Three real-relay repeats each
reached all 100 unique seeded gap rows. No pager change was required. The focus
workspace test now establishes an actual midpoint instead of accidentally asking
the browser to preserve a position beyond its new maximum; its original 2px
anchor tolerance, same DOM/input and retained draft assertions remain intact.

The configured hosted signup route was independently reachable: GET returned
405 (the route requires POST) and its OPTIONS preflight returned 200 with the
required method/header/origin allowances. These read-only requests do not prove
account creation.

The combined final-source browser gate passed all 29 checks, covering every
identified smoke failure and the approved onboarding/identity/appearance states.
All five window-control checks also passed: existing macOS default/min/max
zoom and real Windows switcher/unread-control clicks at 560px and 360px heights.
The final `just ci` run passed with 6,871 desktop tests, 2,922 native tests and
967 mobile tests. New GitHub CI and the final-revision package remain pending.

## Earlier checks retained as historical evidence

These results preceded the rejected PR visual review and/or subsequent source
changes. They remain useful regression history, but must not be presented as
final-source visual, CI or package acceptance.

| Earlier gate | Observed result |
| --- | --- |
| Onboarding screens, narrow/short windows, import geometry, recovery retry and website context | 14 Playwright tests passed on that build |
| Returning sign-in and taken-email escape | 2 Playwright tests passed |
| Agent message/DM identity, long messages with a native Block, stable colour and editable role | 3 Playwright tests passed |
| Key/profile/recovery and second-identity paths | 11 Playwright tests passed |
| Onboarding integration suite | 51 Playwright tests passed |
| Additional business and existing credits display | 5 Playwright tests passed |
| Thread split/focus/width and appearance reload | 6 Playwright tests passed |
| Theme and appearance | 24 Playwright tests passed before the structural correction |
| Desktop unit suite | 6,859 tests passed |
| Native desktop unit suite | 2,922 passed; 25 explicitly ignored environment/performance cases |
| Repository gate | An earlier `just ci` passed, including desktop/native/Rust/web checks and 967 mobile tests |
| Source gates | Earlier TypeScript, Biome, file-size, text-token, native inventory and bridge-boundary checks passed |

The earlier screenshots included 1440px and 360px onboarding, 1280×720 and
800×500 short-window checks, coloured workspaces and generic inline work. They
proved those rendered interactions, but the owner subsequently rejected their
match to the approved visual direction. The clickable HTML preview has its own
interaction evidence in the spec; it is not a production-component test.

## Failures found and corrected in source

- The initial colour-only workspace implementation missed the approved sidebar,
  separate frames, title hierarchy and reading composition. The structural
  correction and final comparison replace that failed gate.
- Adding the 12px pane gutter exposed a 288px channel at an 860px window. The
  existing split threshold and drawer width now reserve the gutter; this case
  was observed failing before the fix and passing afterward.
- Applying that gutter to workspace/profile layouts also clipped a workspace by
  11.984px and left a profile's channel at 288px. Scope it to the split thread;
  the existing sibling layouts retain their own width allocation.
- Taller sender headers exposed a 44px drift when history prepends changed a
  root into a continuation. The virtualizer now preserves durable bottom intent
  or the retained reading row through measurement, yielding to real reader input.
- Long-message expansion could leak when switching thread roots. Internal
  disclosure state is keyed by the pane/message scope, with bounded memory.
- A pending business submit could activate the previous owner's workspace after
  leaving setup. Run/identity guards stop late side effects and phase handoffs;
  busy exits are disabled and the persisted provisioning candidate is retained.
- `light-dark()` lowered into unresolved CSS switches, making form backgrounds
  transparent. Explicit light/dark tokens and computed-colour checks cover
  opaque fields and cards.
- The primary-button selector targeted attributes the shared Button does not
  render. Scoped classes apply the dark CTA and opaque disabled state.
- Ants crossed introductory copy, and dark placeholders inherited a light
  colour. Decoration masks and explicit placeholder tokens corrected them.
- A 720px-high business form overflowed by 13px. Short-window chrome spacing was
  reduced without shrinking fields or body text.
- A browser-import identity query mounted outside its provider and prevented
  startup. Eligibility now uses the existing native identity API, and import is
  deferred until actual onboarding completion.
- A previous community's ready flag could complete another handoff. Completion
  requires the exact target relay for the current identity.
- Rejected email/taken-address attempts blocked corrections. Only definitive
  rejection releases the exact prepared attempt. Registered, uncertain, locked,
  partial and incomplete-ownership outcomes preserve recovery state.

The retry and ownership regressions were observed failing before their fixes,
then independently re-reviewed. Native recovery checks cover identity/attempt
binding, registered-state protection, durable reuse and exclusive owner-only
export. These checks do not replace the final installable-beta gate.

## Required final gates

1. Rebuild the final source, compare equivalent realistic conversations against
   the approved visual reference in light/dark and narrow/desktop layouts, and
   verify the final palette, quiet selection, long-text expansion, scrolling,
   roles, generic work blocks and independent drafts.
2. Run affected source/browser checks and the required repository and GitHub
   gates on that revision. Record any failure rather than carrying forward an
   earlier green result. PR checks, merge-queue checks and actual merge are
   separate states.
3. Rerun the corrected beta completion fixture on the final revision. Verify the
   packaged relay default, then run the real renderer/native signup against an
   ephemeral localhost account fixture and relaunch it to check recovery
   continuity. Optional screenshots mask recovery material and cleanup is
   restricted to the unique synthetic profile. A workflow artifact is not ready
   until its relevant package smoke succeeds.
4. Record available download/release evidence separately. Actual OS save-dialog
   interaction, real hosted signup and live business delivery remain beyond
   mocked-save/local-account fixtures and require their own stated proof.
