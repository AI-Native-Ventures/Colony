# Local Agent Isolation Implementation Plan

**Goal:** Prevent Colony-managed local workers from reading another worker's
browser grants, browser profile or private files while keeping allowed work usable.

**Architecture:** A native policy builder describes the worker's permitted paths
and endpoints. On macOS it creates a `/usr/bin/sandbox-exec` launch with fixed
parameter names and canonical paths. The native launcher will own policy creation;
agent configuration cannot widen it. Other platforms fail closed until an
implementation is proven.

**Tech stack:** Rust process APIs, macOS Seatbelt, existing ACP and MCP binaries.

## Gate 1: native boundary

- [x] Add `desktop/src-tauri/src/managed_agents/isolation.rs` with path
  canonicalization, bounded exact endpoint rules and a command constructor.
- [x] Add real-process tests under `isolation/tests.rs`: allowed file operations,
  denied sibling files, symlinks and shell-child inheritance.
- [x] Test socket/network denial with responding synthetic services and positive
  controls; test the real locally built MCP and agent binaries with a deterministic
  HTTP model. Packaged runtime adoption remains in Gate 2.
- [x] Run native formatting, focused tests and clippy; inspect failures instead
  of widening the profile broadly to make tests pass.

## Gate 2: adoption

- [ ] Trace native launch environment and runtime file requirements; integrate
  only after the native boundary passes. Apply HOME/temp/config isolation before
  starting the harness, covering all descendants.
- [ ] Supply exact browser-grant and loopback gateway permissions; prove an unassigned
  worker cannot reuse another worker's connection.
- [ ] Re-run managed-worker lifecycle and packaged browser tests with a
  deterministic model fixture. Keep actual provider/Instagram proof separate.

No production promotion or automatic credential migration is included.


### Gate 2 implementation constraints discovered by Gate 1

- Seatbelt cannot directly express a per-IP remote allowlist. Implement a trusted
  per-worker gateway with explicit upstream destinations and unique local port.
  Audit HTTP, WebSocket and tool subprocess paths; environment-only proxy settings
  do not constrain callers and cannot replace the OS rule.
- Wrap the complete native-launched ACP harness, not only the inner agent or MCP.
  The complete agent proof in Gate 1 was a test-driven ACP session, not a managed
  roster entry or native-launch adoption.
- Do not mount the shared nest/home to recover missing config. Provision the
  minimum worker-owned config and selected credentials explicitly.
- Start with the built-in runtime; reject unsupported Electron launch paths rather
  than falling back to an unrestricted process. Do not change legacy Tauri agents
  or claim they are covered by the Electron boundary.
- Keep the previously committed managed-browser draft unpublished until adoption
  and real lifecycle gates pass. No new PR was opened for the test-only prototype.


### Gate 1 evidence (2026-09-08)

- Restrictive policy: 11/11 tests passed, including the two opt-in real-binary
  tests. All secrets and model responses were synthetic.
- Mutation control: replacing only `(deny default)` with `(allow default)` made
  9 of 11 tests fail. The restrictive policy was restored and the suite passed.
- Electron-feature native clippy (`--lib --tests -- -D warnings`) passed.
- This is local proof only. No native managed-launch adoption, package proof of
  isolation, authenticated browser proof, new PR, or merge is claimed.

Reproduce the real-binary tests after building `buzz-agent` and `buzz-dev-mcp`:

```sh
. ./bin/activate-hermit
COLONY_ISOLATION_MCP="$PWD/target/debug/buzz-dev-mcp" \
COLONY_ISOLATION_AGENT="$PWD/target/debug/buzz-agent" \
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib \
  managed_agents::isolation -- --include-ignored
```

Run outside an already active OS sandbox so Seatbelt can initialize. An outer
sandbox refusal is not evidence that the product's boundary has been applied.
