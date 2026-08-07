# Browser Engine Shell Decision

Date: 2026-08-07
Status: Draft — pending live agent gate and owner decision

## What the spike proved

`buzz-browser` (Rust) launches headless Chromium, drives it over CDP, and
exposes snapshot-first MCP tools over stdio. The reference journey completes in
2 calls / 148 estimated tokens; the naive DOM-dump baseline is 3 calls / 301
tokens. The daemon is shell-agnostic: it runs today without any desktop shell.

The live ACP agent gate is **not yet passed**: the wiring compiles and its unit
tests pass, but the available `goose` ACP session reports an internal error and
`codex-acp` / `claude-agent-acp` are not installed on this machine.

## The decision: Electron vs Tauri + sidecar

The channel-browser design spec requires: a right-split pane inside a thread,
live agent cursor/highlights while watched, per-channel isolated sessions with
restored tabs/signed-in state, and agents driving the page through the same
engine.

### Electron

**Live-view fidelity:** native. Each tab is a real Chromium web contents
(`WebContentsView`), so the human sees the exact page the agent drives — cursor,
highlights, and DOM state with zero proxy lag. This is the Codex shape.

**Isolation:** per-channel persistent partitions (`persist:<channel-id>`) are a
first-class Electron concept; cookies/storage isolate per channel with
app-managed tab/history state on top. Proven pattern (Min, Ferdium, rever).

**Agent control:** identical CDP path; `webContents.debugger` works on any tab.
No parity risk.

**Bundle size:** large (~100 MB+ Chromium). Acceptable for an agent OS; Codex
already ships this.

**Migration cost:** high. Colony's Tauri layer owns the relay client, media
proxy, keychain, agent runtime, mesh LLM, and worker hosts. Moving the shell
means re-homing that native surface.

### Tauri + sidecar Chromium

**Live-view fidelity:** second-class. The app webview cannot host Chromium tabs;
the human sees either a screencast stream (latency, no true DOM feel) or a
separate window, which breaks "inside the thread."

**Isolation:** possible via sidecar profiles/partitions, but every per-channel
session is app-managed state over a remote CDP process — more custom plumbing.

**Agent control:** identical CDP path (the daemon is already shell-agnostic).

**Bundle size:** smaller app, but still requires Chromium as a sidecar (either
system Chrome or a bundled binary), so the size win is modest.

**Migration cost:** low — the spike IS this path; the desktop integration
plugs the daemon into Tauri.

## Recommendation

**Move the shell to Electron** once the channel-browser workspace is the
product center. The spec's live-view and per-channel isolation requirements are
structurally free in Electron and expensive/impossible-feeling in Tauri. The
`buzz-browser` Rust daemon stays as the engine either way (mirroring Codex's
Electron + Rust backend split).

If browser-in-thread is a feature rather than the product center, Tauri +
sidecar remains viable for v1 with a streamed human view — but that decision
should be made explicitly, knowing the live-view tradeoff.

## Decision owner

Basheer (product scope + shipping risk). The memo's recommendation is the
technical input, not the decision.
