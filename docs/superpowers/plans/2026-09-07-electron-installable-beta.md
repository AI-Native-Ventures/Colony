# Electron installable beta implementation plan

The founder approved this next phase after PR #644 merged. Routine architecture,
implementation and validation decisions remain delegated to the agent.

**Goal:** Launch the existing Colony app from a relocatable macOS application
bundle with real native services, then connect an owner-selected browser tab to
a managed worker without manual MCP configuration.

**Architecture:** Preserve the merged private Electron/Rust transport. Package a
small allowlisted application directory using Electron Packager, with native
executables together outside the application archive. Resolve bundled resources
relative to the application, independent of the shell's working directory and
PATH. Keep beta data separate from the installed Tauri app. Use the existing
managed-agent ACP MCP-server path for scoped browser assignment; never provide
an unscoped DevTools endpoint to a worker.

## Gate 1: executable package

- [x] Inspect the failed Blocks action using CI artifacts and re-run the live gate.
  The rerun passed; the original action submission timeout is not proven fixed.
- [x] Add `desktop/src-electron/runtime-paths.mjs` and focused tests for packaged
  host resolution, missing/invalid executables and development overrides.
- [x] Update `main.mjs` to use packaged paths and distinct beta identity. Ship
  the existing CSP configuration and built frontend without developer files.
- [x] Add `desktop/scripts/electron-package.mjs`: build real Rust host/helpers,
  stage an allowlisted app, package macOS .app, validate helper executable
  headers, and write a versioned zip and artifact manifest. Compilation stubs
  are forbidden in the output. Discover Cargo target paths using metadata.
- [x] Add a package smoke entry that relocates the application outside the
  repository, starts without COLONY_NATIVE_HOST or a developer PATH, checks
  native commands and actual helper discovery, then exercises browser/import
  persistence and cleanup using synthetic accounts.
- [x] Run focused tests, frontend checks/build, native checks and required
  repository gates. Document exact local package proof and signing status.

## Gate 2: managed browser work

- [x] Inspect the existing ACP browser MCP injection and managed-agent spawn
  authority. Bind grants to the selected local worker and active business.
- [x] Replace manual grant-file setup with owner controls identifying the
  teammate and read/interact scope. Deliver configuration through local native
  state, never relay events or public agent definitions.
- [x] Prove a real managed process receives the scoped server; prove takeover,
  business switch, tab close, restart and agent stop revoke access. Keep the
  existing native browser absence behavior for Tauri.
- [ ] Exercise an authenticated Colony Instagram draft after owner-selected
  sign-in is available. Do not publish as part of this acceptance test.

## Delivery

Submit coherent tested changes to develop and arm auto-merge under the existing
authorization. Preserve separate claims for local bundle proof, CI, merge,
code signing/notarization, distribution, and authenticated managed-agent work.
The beta must not become the default release before remaining shell parity is
proven. No production promotion is included in this phase.

## Gate 1 proof (2026-09-07)

- Full `just ci` passed: 6,837 desktop tests, 2,893 native tests (21 existing
  ignores), 967 mobile tests (one existing skip), plus workspace checks/builds.
- Electron tests: 35 passed. CI inventory/file-size contracts: 26 passed.
  Explicit electron-host feature clippy and focused tests passed.
- Independent review corrected cross-profile legacy reaping and packaged helper
  PATH precedence, with failing-before/passing-after regressions. The bundle
  retains the native process name recognized by older Tauri worker reapers.
- Rebuilt debug Apple Silicon app: ad-hoc signature verified, all seven native
  binaries linked only to system libraries. Relocated package smoke passed with
  minimal PATH, real Rust dispatch/helper discovery, synthetic cookie import,
  scripted worker takeover, business isolation, and persistence across restart.
  This uses synthetic identity and a local authenticated fixture, not Instagram
  or a real managed teammate. No personal browser cookie values were read.
- Blocks Live Gate rerun: GitHub run 34160311887, attempt 2, success. Original
  evidence showed an action-publication timeout and rate-limit notices, but did
  not establish causation. No speculative product fix was applied.
- Release-profile CI packaging, notarization, distribution, live managed worker
  lifecycle and authenticated Instagram work remain unproven.

## Gate 2 follow-up (2026-09-08)

The managed browser implementation now runs under the macOS Electron worker
isolation boundary. The packaged synthetic workflow proves real managed-agent
browser work, sibling denial, takeover, read-only access, process restart and app
relaunch. Browser authority tests additionally cover business changes and tab
closure. This is not an authenticated Instagram pilot. See the local-agent
isolation plan for current validation and delivery status.

PR #645 merged to develop; its release-profile beta workflow passed. That earlier
artifact does not contain the follow-up isolation implementation. Neither phase
is a production promotion or notarized public release.
