# Electron shared-browser prototype

Status: approved direction and prototype acceptance scope in the founder conversation on 2026-09-07; implementation begins in an isolated worktree. This is not authorisation to migrate production data or publish social content.

## Decision and scope

Build an Electron browser shell alongside the existing Tauri desktop. The founder approved testing persistent Instagram login, several tabs, agent control, human takeover and resource usage before deciding the remaining migration. Electron is the preferred clean-sheet architecture; Tauri plus the existing Chromium sidecar remains the comparison baseline. Replacing the whole desktop now would combine browser feasibility with an unrelated native-service port, so it is outside this phase.

## Architecture

The independent `experiments/electron-browser` package uses Electron WebContentsView for real browser pages, a small local shell for navigation, and named persistent session partitions for Colony and Horizon. Browser data is stored only in the experiment's ignored state directory. No access to the existing Tauri keychain or Codex profile is needed. The existing Rust services remain intact.

A main-process broker holds tab identity, account scope and revocable agent grants. Each grant names one tab and its current origin. A stdio MCP adapter exposes list, snapshot, click, type and screenshot operations through a local Unix socket; it never exposes a raw debugging port or unrestricted JavaScript execution. The shell can grant access to a visible tab, and taking control revokes it. Agent requests are serialized per tab; separate tabs can proceed independently. Navigation invalidates snapshot references. One grant cannot see another business's tabs. Untrusted remote pages have sandboxing and context isolation, no Node integration or privileged preload. Privileged shell IPC checks the sender. Permissions and external popup requests are denied in this bounded prototype.

The initial implementation is macOS/Linux because the local broker uses a Unix socket. Windows support, installers, production agent configuration, full browser features and native-service migration are not claimed. Tooling must remain model-independent.

## Gates

1. Unit tests reject cross-tab access, expired/revoked grants, competing controllers, stale observations and malformed commands. Each meaningful guard gets a negative test.
2. Real Electron tests use deterministic local pages. Two brands retain separate cookies/storage; data survives a process restart; several tabs are discoverable within the granted scope; a worker reads and changes its actual WebContentsView; takeover rejects subsequent actions; navigation rejects stale refs. A remote page cannot invoke shell IPC. Capture screenshot and resource measurements with fixture and conditions identified. These tests do not prove external login.
3. Open the prototype for owner inspection without stealing focus. Instagram login requires the owner in this separate profile. Do not copy browser cookies or credentials. After login, verify the actual profile and persistence. If owner interaction is pending, stop at that precise proof boundary rather than claiming full acceptance.

## Limits and failure behavior

Human takeover prevents further agent commands; it cannot reverse a browser action already dispatched. Revocation is checked again around asynchronous work, and stale work cannot regain control. Browser navigation/crashes destroy prior observations. Closing the application stops broker connections and destroys temporary grants but retains authorised browser storage. Secrets and page text are not written to the audit log. A local principal with the same operating-system access can read local files; grants are not an OS sandbox.

Resource measurements cover this prototype only until a matched Tauri run is performed. No efficiency advantage or migration effort estimate is asserted in advance.

References: https://www.electronjs.org/docs/latest/api/web-contents-view , https://www.electronjs.org/docs/latest/api/session , https://www.electronjs.org/docs/latest/tutorial/security . Existing comparison: `docs/design/browser-engine-decision.md` (historical, not current runtime proof).
