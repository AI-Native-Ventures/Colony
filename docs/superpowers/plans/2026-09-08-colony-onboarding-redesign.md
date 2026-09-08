# Colony Onboarding Redesign Implementation Plan

> For agentic workers: execute the owned slice with the existing collaboration tools, with parent review before delivery. The user explicitly approved the design and autonomous implementation.

**Goal:** Deliver the approved account/recovery/business journey with reliable retries, then enter the existing Welcome conversation.

**Architecture:** Keep native identity, account crypto, provisionWorkspace and Welcome delivery as the sources of truth. Simplify the existing route/state machine rather than adding another account or business store. Persist pending recovery material in the existing native SecretStore and persist transaction markers in the existing scoped onboarding draft.

**Tech Stack:** React, TypeScript, native Rust/Core commands, existing Electron bridge, Node tests, Playwright and packaged signup fixture.

## Current execution state

The account/recovery/business source journey and retry corrections are
implemented. The latest scoped account browser suite has 19 passing tests and
the scoped source unit suite has 451, reported by the coordinating agent. These
are separate from the earlier full-repository run. The first PR's visual
acceptance claim was rejected and superseded. Corrected-source browser checks
and fresh final onboarding/workspace screenshots replace that failed gate;
packaged verification remains separate. The latest beta smoke
failed on a completion-state fixture after browser import moved behind actual
onboarding completion. Its corrected fixture/package rerun, final CI, merge and
available beta are pending. See [the proof ledger](../reports/2026-09-08-colony-redesign-proof.md).

## Ownership and boundaries

Onboarding worker owns `desktop/src/features/onboarding/**`, onboarding tests/helpers, the narrow pending-signup/recovery-save native API and required identity-command registration, plus the App/machine entry wiring and browser import deferral directly needed by this journey. Coordinate any shared `main.tsx`/registry changes with parent. Parent owns Electron package configuration/signup smoke script and workspace identity presentation. Theme worker owns global theme/preferences/settings and shared workspace surfaces.

Read `docs/superpowers/specs/2026-09-08-simple-founder-onboarding-design.md` as the acceptance contract. No new social-media workflow, publishing path, task store or artificial agent output belongs in this slice. Preserve current users, sign-in, identity import, invites and adding a business.

## Task 1: Durable account/recovery checkpoint

Files:
- `desktop/src/features/onboarding/authService.ts`, contracts, `lib/wiredAuthService.ts`, fakes and auth tests.
- `desktop/src/shared/api/tauriIdentity.ts`.
- Dedicated native recovery command module beside `desktop/src-tauri/src/commands/identity.rs`, registered through the existing command path.
- `desktop/src/features/onboarding/ui/new/screens/RecoveryScreen.tsx`.

- [x] Inspect existing SecretStore and native `save_ncryptsec_copy` implementation before defining the narrow recovery command wrappers. Reuse the store and save-dialog/write result conventions; never relax encrypted-key-backup validation to accept ordinary text.
- [x] Define a persisted pending record bound to current identity and normalized signup email. It holds the recovery code and stable attempt marker, not the password. Create/reuse it before the account POST. Never put it in localStorage, analytics or ordinary logs.
- [x] Make native save return an explicit saved/cancelled outcome. Only successful native writing or an explicit copy-path acknowledgement can complete recovery; failed clipboard copying and empty codes remain visible failures.
- [x] Restore the same pending checkpoint after relaunch/uncertain POST. Clear a registered checkpoint only after successful recovery acknowledgement. A definitively rejected prepared attempt can be discarded only by the native identity/attempt-bound transition; uncertain, locked, partial and incomplete-ownership outcomes preserve it. An old unrecoverable checkpoint offers sign-in and cannot be silently marked complete.
- [x] Add failing regression tests for storage failure before POST, same-code retry/relaunch, cancelled/failed save and missing old secret; implement and rerun. Use synthetic identities/data, boolean secret assertions and no live account writes.

## Task 2: Two-form journey and branded screens

Files:
- `desktop/src/features/onboarding/ui/new/NewOnboardingFlow.tsx`.
- `desktop/src/features/onboarding/flow/steps.ts`, `persistence.ts` and existing tests.
- `desktop/src/features/onboarding/ui/new/screens/AccountScreen.tsx`, `RecoveryScreen.tsx`, `CompanyScreen.tsx`.
- `desktop/src/features/onboarding/ui/new/OnboardingCanvas.tsx`, `MachineCanvas.tsx`, canvas theme/CSS and existing ant components.
- `desktop/src/features/onboarding/ui/MachineOnboardingFlow.tsx`.

- [x] Default to account, recovery safeguard, business, then existing completion. Fold the redundant entry hero into email/password account entry. Remove name/gender/revenue/runtime/funding questions from the primary setup journey; retain optional profile/advanced paths.
- [x] Keep email/password values and specific error states on retry. Preserve sign-in and explicit key-import entry paths, and current locked/lost identity safeguards.
- [x] Ask for business name and optional website, with immediate manual description. Display a real editable scan result inline. A stale scan response cannot overwrite user edits; failure allows manual completion.
- [x] Implement the approved multicolour background, actual ants, opaque forms and compact text hierarchy with named rem tokens. No app sidebar appears during account/business setup. Decorative motion does not run while entering details.
- [x] Migrate old step/answer drafts to valid remaining checkpoints without clearing business context. Additional-business setup skips account/recovery and retains an exit.

## Task 3: Retry-stable provisioning and Welcome handoff

Files:
- `desktop/src/features/onboarding/flow/provisionWorkspace.ts`, `founderBrief.ts`, `completeFirstRun.ts` and tests.
- `desktop/src/features/onboarding/ui/new/CanvasFirstRunHost.tsx`, `AdditionalCommunityRun.tsx`.
- `desktop/src/features/onboarding/automaticAgentSetup.ts`, `automaticRuntime.ts`, `freshSignupDefaults.ts`.
- `desktop/src/app/App.tsx` and browser import entry gating if needed.

- [x] Persist the candidate business/provisioning attempt before sending create. Reconcile ownership after an uncertain response before choosing another candidate. Guard duplicate clicks and concurrent retry.
- [x] Persist the first-brief delivery marker in the scoped answers. Rebuilding a completion draft must retain it; reuse existing marker-based delivery and Welcome channel lookup.
- [x] Await built-in default configuration/readiness through the current runtime catalog and config core. Preserve deliberately configured existing users; do not choose personal CLI subscriptions or invent a second capability table.
- [x] Open the existing Welcome conversation after successful completion. Preserve the existing first-job brief, native task/thread path, zero-credit notice and real payment/retry controls. Any setup-authored suggestion is labelled as setup, never as completed agent work.
- [x] Defer browser-session import until actual onboarding completion; preserve the voluntary first-use and Settings import actions.
- [x] Add regression checks for uncertain creation, stable delivery marker, config failure, additional-business isolation and interrupted setup. Existing completion/Welcome tests remain valid guards.

## Task 4: Rendered and packaged proof

- [x] Run scoped auth, recovery, persistence, provisioning, defaults and Welcome tests. Run only relevant native tests for the new commands locally when the configured toolchain can execute; required CI remains a separate gate.
- [x] Update onboarding E2E to exercise fresh account, failed signup retry, recovery save/cancel, interrupted recovery, website/manual business entry, existing sign-in and additional-business exit. Use `build:e2e` with the mock bridge for screenshots; parent coordinates the shared build/server.
- [ ] Capture actual account, recovery, business, failure and Welcome screens, in desktop/narrow and light/dark appearances. Compare against the approved preview and inspect reading/field boundaries and ant placement.
- [ ] Complete the `desktop/src-electron/signup-smoke.mjs` package gate. The script
  has been updated for account/recovery and relaunch continuity, but the latest
  beta run failed on its completion fixture. Correct that fixture, independently
  assert the compiled relay default, then pass actual renderer/native signup
  against an ephemeral localhost account service. Keep cleanup limited to the
  exact synthetic profile and mask recovery material in optional screenshots.
  Do not create hosted accounts or call an earlier fixture run final package proof.
- [ ] Parent runs required checks/review and integrates this slice into PR delivery. Record source/unit, mock E2E, native, packaged, CI and merge evidence separately.

## Acceptance gate

A fresh founder can complete account plus recoverable setup and supply one useful piece of business context without choosing models/providers or paying during onboarding. Retry/relaunch cannot lose the pending recovery code, create another business or repeat the first brief. Existing user paths remain available. Completion also requires the actual final-source app to match the approved design and required checks to pass. That acceptance is still open after the rejected initial PR screenshots. The latest failed beta fixture must pass on rerun before calling the installable beta ready; source, browser, native, package, CI, merge and release remain distinct claims.
