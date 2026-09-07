# Electron runtime and sign-in import delivery

The founder authorized implementation through PR readiness and green-gated integration on 2026-09-07. Use the existing migration branch; do not pause for routine implementation or PR decisions.

## Revised transport strategy

Electron owns the existing React UI and native website views. The first independently reviewable cut keeps the current Rust command handlers in a feature-gated compatibility host, using private parent/child stdio instead of a public HTTP listener. Tauri remains an internal Rust dependency temporarily; a blank non-visible dispatch webview supplies its command context. It never renders Colony's React UI or a remote site. This is an explicit transition, not completion of the standalone Rust extraction or a performance improvement claim.

The compatibility boundary uses Tauri's custom invoke API and channel interceptor, preserving existing native serialization, ACLs, errors and channel payloads. The main Electron renderer gets a narrow preload. Remote browser pages do not. Validate trusted sender/frame and reject arbitrary external navigation of the privileged renderer. Process exit rejects pending calls; stdin closure shuts down the native host. Never print transport payloads to diagnostic logs.

## Delivery gates

- [x] Native host transport: feature opt-in, bounded framed JSON/binary, command/result/error, subscription/event, channel push and orderly shutdown. Unknown commands fail rather than return fake values. Keep ordinary Tauri boot unchanged.
- [x] Electron shell: actual desktop React entry and a complete NativeBridge adapter, shell operations, native host lifecycle, own dev data, page navigation boundary. Existing business command coverage comes from the real Rust dispatcher. Record native shell operations still requiring parity work.
- [x] Browser workspace: transfer proven native views into the existing web-tab lifecycle and preserve community/account isolation, owner takeover and agent access.
- [x] Sign-in import: first-launch invitation and repeat Settings flow, metadata discovery, owner-selected source/site/destination, supported source adapters, explicit unsupported outcomes, cookie attribute preservation and no raw credentials in renderer IPC/logs.
- [x] Tests: transport fault injection, source-cookie fixtures, real Electron cookie store + restart, real native host invocation, actual UI inspection. Manual external account proof remains separate from fixture proof.
- [ ] Repository checks: current-base review, required local gates, scoped signed-off commits, PR targeting develop, arm auto-merge, inspect queue checks. Do not promote to production as part of this branch.

## Code ownership

- `desktop/src-tauri/src/electron_host/`: compatibility transport and tests.
- `desktop/src-tauri/src/lib.rs`, Cargo feature: gated integration only.
- `desktop/src-electron/`: main process, preload, host RPC and browser account/import services.
- `desktop/src/shared/api/electronNativeBridge.ts`, `desktop/src/main.tsx`: adapter selection without changing business feature call shapes.
- `desktop/src/features/settings/` and onboarding: owner-facing import entry points, available only when the shell supports them.
- `desktop/src/features/workspace/`: embedded native browser view lifecycle.

Before each PR, compare the completed code against these gates and list every unpassed gate explicitly. A partial compatibility PR may be merged behind an opt-in feature only after its own gates pass; it is not the final migration.

## Validation findings incorporated

- The actual React renderer exposed a welcome-dialog provider ordering crash; the
  invitation now mounts below ThemeProvider.
- The ordinary desktop build and Electron helper initially shared a binary path.
  A required-feature `colony-native-host` binary and frozen smoke copies now keep
  those artifacts distinct.
- The startup Codex capability probe inherited private transport stdin. Its
  synthetic subprocess regression fails without stdin isolation and passes with
  it. Independent reconnect/media/terminal launchers also receive null stdin.
- A transient WouldBlock read could terminate the helper and discard a partial
  frame. A fault-injected reader reproduces the old failure; the bounded reader
  now preserves the partial frame and retries transient errors.
- Chromium's Windows-epoch microsecond timestamps exceed JavaScript's safe integer
  limit. A real SQLite fixture reproduced the failure; integer reads now use
  BigInt before conversion to Electron's seconds-based cookie API.
- Independent review identified missing Electron CSP, skipped cleanup after an
  individual failure, unconfirmed child termination and hidden-window activation.
  These were corrected and the reviewer verified the fixes; runtime checks remain
  separate from that source review.

The superseded standalone prototype is retained in its original branch history,
not included in the actual-desktop PR. Remaining release parity gates are listed
in `desktop/src-electron/README.md`; this opt-in phase does not replace the signed
Tauri distribution or claim external-account authentication.


## Local proof for this opt-in phase

- `just ci`: passed, including workspace Rust checks/tests, 6,829 desktop tests,
  the frontend build, 2,887 desktop Rust tests (21 existing ignores), the web build,
  and 967 mobile tests (one existing skip).
- After the final reload review fix: all 6,835 desktop tests passed; 33 focused
  Electron tests passed; desktop check and frontend build passed.
- Electron-feature Rust clippy passed; all four wire-protocol tests passed.
- The Codex probe stdin regression and partial-frame WouldBlock regression each
  failed against the unfixed implementation and passed after correction.
- A real Rust WebSocket reload regression failed with the old connection still
  open before the fix. It now passes with old connections/subscriptions retired,
  a fresh stream at sequence zero, and nonreused native channel identities.
- Development smoke passed: actual React/Rust request/events, first-launch dialog,
  Settings menu → Browser, remote-view isolation, business revocation, selected
  synthetic Firefox cookie import → authenticated local page, scripted worker
  read/type, owner takeover, and persistent cookies after a real Electron restart.
- Built-asset smoke passed the same gate, including the visible import flow and
  restart, after the frontend build finished. Concurrent
  rebuilds can invalidate imported chunk names, so they are not a valid artifact
  for this gate. The entry document's inline theme bootstrap receives an exact
  CSP hash, as does Vite's preamble in development.

The owner import UI has been visually inspected. Browser/profile detection is
real metadata discovery; authentication uses a synthetic local store and page,
not personal cookies or Instagram. Scripted scoped tool use does not prove a
managed LLM worker automatically receiving its browser grant. Per-site account
verification, additional import adapters, auxiliary-window/permission parity,
release packaging/signing/updater and complete Tauri removal remain subsequent
migration gates, recorded in the runtime README. These gates are not checked off
by this PR.

Visual inspection also caught the default Electron engine version in Settings.
A live assertion failed with 44.2.0 versus Colony 0.16.7; the shell now reads the
Colony package version, and the final built smoke passed that assertion.

GitHub's initial path-detection gate found a native inventory mismatch caused by
this phase's generic event forwarder. The failure reproduced locally (50 versus
51 emit sites). Routing through the existing `TauriEventSink` keeps the event
contract intact and the inventory gate unchanged; its 26 tests now pass, as do
21 additional path/instance/schema contract tests. No guard was disabled.
