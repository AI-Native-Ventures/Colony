# Browser Engine Shell Decision

Date: 2026-08-07 (revised same day, after the channel-workspace redesign)
Status: Decided, Electron. Owner delegated the call to the session on
2026-08-07 after the redesign; gate 8 (live ACP journey) has passed.
**No migration has started.** See the 2026-08-09 update below.

## Update 2026-08-09: the decision is still reversible, and cheaply

`browser_connect` now takes a DevTools `endpoint` and attaches to a browser it
did not launch, instead of only launching its own (`host::attach`,
`host::parse_endpoint`, `mcp::open_host`). The daemon owns the process only in
the launch case, so dropping an attached host leaves the shell's browser alone.

This matters for the decision below, because it removes the coupling between
the engine and the shell:

- The same daemon drives an Electron `WebContentsView` and a sidecar Chromium.
  Both are a DevTools endpoint, and neither needs a code change here.
- The engine can therefore ship, and agents can browse, before any shell
  question is settled. The Electron case rests on live-view fidelity inside the
  channel content column, which is a product claim that has not been tested with
  a user yet.
- Nothing in the migration has been built, so the cost of waiting is zero and
  the cost of being wrong is the whole native surface (relay client, media
  proxy, keychain, agent runtime, mesh LLM, worker hosts) plus a one-way
  keychain data migration.

Recommendation to the owner: keep the Electron decision recorded but do not
start the migration until the workspace product value is demonstrated on the
current shell. This update does not overturn the decision; it records that the
engine no longer forces it.

## What the spike proved

`buzz-browser` (Rust) launches headless Chromium, drives it over CDP, and
exposes snapshot-first MCP tools over stdio. The reference journey completes in
2 calls / 148 estimated tokens; the naive DOM-dump baseline is 3 calls / 317
tokens. The daemon is shell-agnostic: it runs today without any desktop shell.

The live ACP agent gate **passed on 2026-08-07.** An unmodified
`claude-agent-acp` 0.59.0 session (already the adapter every managed Colony
agent runs) drove the full journey through the daemon using browser MCP tools
only: `browser_connect -> browser_navigate -> browser_click -> browser_type ->
browser_click -> context_budget_report`; the page flipped `not-submitted` ->
`PASS`, clean `EndTurn`. The earlier claim that "`goose` ... reports an internal
error and `codex-acp` / `claude-agent-acp` are not installed" was wrong where
it mattered: `claude-agent-acp` 0.59.0 is available
(`~/.npm-global/bin/claude-agent-acp`), `goose` 1.45.0 is installed, and all 16
managed Colony agents run on `claude-agent-acp`. Passing required two wiring
fixes, both landed in the spike: (1) the agent runs in a neutral temp cwd so it
does not load repo `AGENTS.md`/the spike plan and derail; (2) the toolset is
locked via `_meta.claudeCode.options.disallowedTools`
(`session_new_with_meta` in `buzz-acp`), because `claude-agent-acp` hardcodes
`ALLOW_BYPASS` and passes `--allow-dangerously-skip-permissions`, which makes a
deny-all `settings.json` inert.

## The decision: Electron vs Tauri + sidecar

The channel-workspace design was revised twice on 2026-08-07
(`docs/superpowers/specs/2026-08-07-colony-channel-browser-workspace-design.md`,
see its "Revision log"). It now requires:

- a **tabbed workspace in the channel's content column** — the column the
  message timeline occupies — with one tab strip and one level of tabs. The
  right pane is untouched, so an open thread stays open and readable beside the
  live workspace;
- **typed tabs**, where `web` is the only kind that ships in v1 and `terminal`,
  `file`, and `scratchpad` are contract-only (proven by a stub kind in tests,
  no second engine);
- live agent cursor/highlights while watched, per-channel isolated sessions
  with restored tabs/signed-in state, and agents driving the page through the
  same engine.

The shell decision is now a **workspace-wide** decision, not a browser-only
one. Whatever shell hosts a `web` tab also has to host a future terminal (PTY)
or file tab **in the same strip**, and the live view occupies the full content
column. Both options below are therefore costed for the CDP `web` kind and for
a non-CDP kind in the same strip.

### Electron

**Live-view fidelity:** native. Each tab is a real Chromium web contents
(`WebContentsView`), so the human sees the exact page the agent drives — cursor,
highlights, and DOM state with zero proxy lag. This is the Codex shape.

**Non-CDP tab kinds:** the same per-tab view primitive covers them. A terminal
tab is a PTY-backed view (node-pty or a Rust PTY backend) rendered in the same
strip; a file tab is a plain web contents hosting an editor. No second surface
mechanism; the strip, ownership, and approvals are shared. This is the shape
Codex already ships.

**Isolation:** per-channel persistent partitions (`persist:<channel-id>`) are a
first-class Electron concept; cookies/storage isolate per channel with
app-managed tab/history state on top. Proven pattern (Min, Ferdium, rever).

**Agent control:** identical CDP path; `webContents.debugger` works on any tab.
No parity risk.

**Bundle size:** large (~100 MB+ Chromium). Acceptable for an agent OS; Codex
already ships this.

**Migration cost:** high. Colony's Tauri layer owns the relay client, media
proxy, keychain, agent runtime, mesh LLM, and worker hosts. Moving the shell
means re-homing that native surface. The keychain is the one irreversible
piece: the current `keyring`-based `SecretStore` holds user nsec keys in macOS
SecKeychain, and Electron's `safeStorage` is a different mechanism, so existing
entries must be read out and rewritten into the new store before the shell
swaps.

### Tauri + sidecar Chromium

**Live-view fidelity:** second-class. The app webview cannot host Chromium tabs;
the human sees either a screencast stream (latency, no true DOM feel) or a
separate window, which breaks "inside the workspace" — and the workspace now
takes the whole content column, so the degraded view is larger, not smaller.

**Non-CDP tab kinds:** per-kind workarounds in the same strip. A terminal needs
a PTY, and Tauri has no first-class embedded terminal, so this means a
canvas-rendered terminal (the upstream Buzz Term pattern: Rust crate + canvas
renderer) or a separate window — both fighting the single-strip rule. A file
tab is a webview editor. The strip would mix sidecar-screencast web, canvas
terminal, and webview file under one tab model with per-kind plumbing.

**Isolation:** possible via sidecar profiles/partitions, but every per-channel
session is app-managed state over a remote CDP process — more custom plumbing.

**Agent control:** identical CDP path (the daemon is already shell-agnostic).

**Bundle size:** smaller app, but still requires Chromium as a sidecar (either
system Chrome or a bundled binary), so the size win is modest.

**Migration cost:** low — the spike IS this path; the desktop integration
plugs the daemon into Tauri.

## Decision

**Electron.** The session took this call on 2026-08-07, delegated by the
owner after the redesign. The design's live-view and per-channel isolation
requirements are structurally free in Electron and
expensive/impossible-feeling in Tauri; the typed-tab workspace strengthens
that: Electron hosts web, terminal, and file tabs with one per-tab view
primitive, while Tauri would need a different mechanism per kind under one
strip. The `buzz-browser` Rust daemon stays as the engine either way
(mirroring Codex's Electron + Rust backend split).

Recorded and rejected: Tauri + sidecar remains technically viable for v1 (v1
ships only the `web` kind), but the live view degrades to a screencast or a
separate window, and a later terminal kind would carry per-kind strip plumbing
either way. The live agent view inside the channel content column is the
product center; that is the deciding constraint.

**No migration starts from this memo.** This is a decision document, not a
work order: the next phase is a written desktop integration plan against the
revised spec, and only that plan's gates authorize moving the native surface.

## Decision owner

Basheer delegated the call to the session on 2026-08-07. Revision history:
v1 drafted by the session (Electron recommendation); v2 aligned with the
channel-workspace redesign; v3 marks the decision and the passed gate 8.
