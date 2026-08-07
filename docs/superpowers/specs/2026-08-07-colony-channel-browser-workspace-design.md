# Colony Channel Browser Workspace design

Date: 2026-08-07
Status: Design approved in brainstorming; pending written-spec review

## Outcome

Colony gets a built-in browser that lives inside a channel as a right-split,
resizable workspace — not a top-level surface, not a canvas tab, not a side
panel item. Any channel can host one browser workspace; the workspace is shared
across that channel's threads, persists with its own isolated session, and can
be driven by the human and by agents under an explicit ownership and approval
model. The engine is the shell-agnostic Rust CDP daemon defined in the browser
engine spike plan, so context economy (snapshot-first, token budgets) is a
design invariant, not a later optimization.

## Product boundary

- The browser is a pane inside a channel: conversation on the left, browser on
  the right, draggable divider, expand-to-full, collapsible. It appears on
  demand (Browser button in the channel/thread header) or automatically when an
  agent starts browsing.
- One browser workspace **per channel**, shared across all threads in that
  channel. Tabs, history, and session persist at the channel level.
- Humans see and drive every tab. Agents see only tabs they created or tabs
  explicitly granted to them; takeover grants pause the previous driver.
- Agent browsing is hybrid: live while watched (cursor, highlights, action
  chip, Pause/Take over), background while unwatched, with evidence posted to
  the thread when done.
- Sensitive actions require approval: an overlay in the browser pane plus a
  mirror message in the thread. Page content is untrusted input, never
  instructions.
- Each channel's browser session is fully isolated (cookies/storage) and
  restores its tabs and signed-in state when reopened.

## Reused and new primitives

| Piece | Decision |
| --- | --- |
| Engine | New Rust crate `crates/buzz-browser`: CDP daemon, snapshot-first tools, context budget (per engine spike plan) |
| Channel scope key | Existing channel UUID (the same identity used by channel events) |
| Evidence posting | Existing message path + media upload for screenshots; no new relay kinds in v1 |
| Approvals | Existing agent ask/approval round-trip; browser approval adds an in-pane overlay on top of the thread mirror |
| Ledger | Browser tool usage feeds the existing cost ledger per channel/agent |
| Community teardown | Browser sessions join `resetCommunityState()` on community switch |
| Secret storage | OS keychain via the existing `SecretStore` for cookie encryption; no hardcoded keys |

## Surface and layout

- The pane is a right split inside a channel's thread view: conversation left,
  browser right. Default proportions 50/50; the divider is draggable; an
  expand control (⤢) makes the browser full-window; collapse returns to
  conversation-only.
- Divider position and expanded/collapsed state are remembered per channel.
- The pane header has: tab strip, URL entry, back/forward/reload, secure-site
  indicator, expand/collapse, and a Background toggle while an agent is active.
- The thread header (in the channel's thread view) has a **Browser** button
  that opens the pane.
- When the pane is collapsed and an agent starts browsing, it auto-opens; when
  the user is in another thread of the same channel, the channel shows an
  "agent browsing" badge and a finished notification via the existing
  notification path.
- Empty state: a new-tab page with a URL/search field and the channel's recent
  browser history.

## Workspace scope and state

- One workspace per channel; threads within the channel share it. Tab identity
  is channel-scoped, never thread-scoped.
- Channel browser state lives in the desktop app (local), keyed by channel id:
  tabs (id, title, url, order), navigation history, scroll positions, divider
  state, and site-permission decisions.
- State is created lazily: no browser process or profile exists until the pane
  is opened or an agent starts browsing for that channel.
- Restore on reopen: tabs return; the active tab loads, other tabs restore
  suspended (Chrome-style lazy restore). History, scroll, and signed-in session
  restore with the channel session.

## Tabs and entry points

- Anyone can create tabs: links in the channel's threads get an **Open in
  browser** affordance; the URL entry adds a tab; agents open tabs when they
  need them.
- Tabs can be reordered, closed, reopened (undo), and renamed by the title.
- A tab belongs to whoever created it for agent-visibility purposes; humans see
  all tabs regardless of creator.
- Tabs are never shared across channels.

## Ownership and concurrency

- One active driver per tab at a time. Drivers are: the human (always allowed)
  and one agent at a time.
- An agent can see and drive:
  - tabs it created, and
  - tabs explicitly granted to it by the human or by the tab's owning agent.
- Granting hands control over: the previous driver (human or agent) is paused;
  a takeover is recorded in the thread (who gave which tab to whom).
- Agents cannot see or touch tabs they do not own or have not been granted,
  including tabs created by other agents.
- When the human interacts with a page (click, type, scroll), the active
  agent's turn is paused and the agent's pending refs are invalidated; the
  agent resumes only on explicit continuation.
- Multiple agents in the same channel never drive the same tab concurrently.

## Agent visibility: live and background

- **Live:** while the user is in the thread, the pane shows the agent driving
  in real time: cursor, highlighted target element, and an action chip
  ("clicking Add to cart"). **Pause** and **Take over** are always available.
- **Background:** a Background toggle lets the agent keep working when the user
  leaves the thread or collapses the pane (app still open). The channel shows a
  browsing badge; a notification fires when the agent finishes or needs
  approval.
- Background does not mean "app closed": when the app quits, local browser
  sessions stop. Cloud continuation is out of scope for v1.
- When the agent finishes (or pauses for approval), it posts evidence to the
  thread: a screenshot plus a short summary, never a full snapshot dump.
- At most N concurrent live/background browser sessions run at once (initial
  cap: 3); extra channels suspend and restore on open. The running set is
  visible in the sidebar/channel list.

## Approvals and security

- Approval card in the pane: page dims, card appears over the target element
  with **Allow once / Allow always / Block**, showing host, method, and the
  action summary. The same ask is mirrored as a thread message so it can be
  approved from anywhere.
- Approval categories:
  - new-site access (first navigation to a host),
  - consequential actions (submit, purchase, delete, permission changes),
  - downloads (via the existing system download flow; uploads are not
    automatable in v1),
  - internal/private URL navigation by an agent (see URL policy).
- **Allow always is scoped per channel + site** by default; per-community is an
  explicit escalation shown in the card. It never silently applies across
  channels.
- Approvals are granted by a human with authority in the channel; the ask
  records who approved and when.
- Page content is untrusted: snapshots and prompts treat page text as data,
  never instructions. Sensitive actions always pass the approval gate
  regardless of page content. Snapshot rendering masks password/token input
  values and any value the user has marked sensitive.
- While an agent is waiting for approval, its turn is paused and the pane shows
  "waiting for approval" with a cancel control.

## Persistence and isolation

- Per-channel **persistent session partition** for cookies/storage (Electron
  partition pattern; Min and rever-browser both use this) rather than a full
  Chromium profile per channel. App-managed state restores tabs, history, and
  scroll.
- No cross-channel, cross-client, or cross-community session leakage. Switching
  communities tears down browser sessions through `resetCommunityState()`.
- Cookie data at rest is encrypted with the OS keychain (`SecretStore` /
  safeStorage); no hardcoded or mock encryption key.
- Lifecycle: channel browser data is created lazily; a channel delete or
  explicit "Clear channel browser data" removes the partition and app state.
  Archiving a channel suspends but keeps data until deleted.

## Engine and context economy

- The pane is powered by the Rust CDP daemon from the browser engine spike
  plan. The daemon is shell-agnostic; the live-view requirement (real-time
  cursor/highlights) is a hard input to the Electron vs Tauri+sidecar decision.
- Tool contract stays snapshot-first: accessibility outline with refs,
  viewport filtering, fresh snapshot bundled with every action, screenshots
  only on demand, lazy bounded network capture.
- Per-task context budget (≤ 25 calls, ≤ 40k estimated input tokens for the
  reference journey) remains the proof gate, and browser tool usage is metered
  into the Colony ledger per channel/agent.

## URL policy

- User-opened navigation: unrestricted by policy (the human is the actor).
- Agent-initiated navigation:
  - public http(s): allowed under site-permission rules;
  - localhost/loopback: allowed only when the user explicitly opened the pane
    for a local dev task or approved the host once;
  - private/cloud-metadata ranges (169.254.169.254, internal RFC1918 beyond
    localhost): blocked by default, requires an explicit approval naming the
    URL.

## Out of scope (v1)

- Mobile app browser pane.
- Multi-device sync of channel browser state.
- File tabs or Codex-style canvas surface.
- Cloud/headless continuation when the app is closed.
- Chrome extensions, stealth/bot-detection bypass, DevTools/developer mode,
  file upload automation, PDF viewer parity.
- Relay-published browser sessions or shared remote browser state.

## Assumptions (state explicitly)

- "Channel" means the existing channel/forum identity in Colony; threads are
  the message threads inside it.
- The pane appears in the thread view of a channel; the workspace belongs to
  the channel regardless of which thread is open.
- Agents in a channel are already subject to the existing tier/ask rules; the
  browser adds tool-level ownership on top, not a new authority model.

## Success criteria

1. A human can open a channel's browser, create tabs, resize/expand/collapse,
   and return later to the same tabs and signed-in session.
2. An agent can create a tab, drive it live (visible cursor/actions), run in
   background, and post screenshot evidence to the thread.
3. Ownership holds: a second agent cannot see the first agent's tab without a
   grant; a takeover pauses the previous driver.
4. Approvals appear in both places, "Allow always" is scoped per channel+site,
   and page content never bypasses the gate.
5. Reference journey passes the context budget, and browser usage appears in
   the ledger.
6. Switching communities tears down all browser sessions; no cookie or tab
   leaks across channels/communities.

## Relationship to the engine spike plan

The spike plan (`docs/superpowers/plans/2026-08-07-colony-browser-engine-spike.md`)
proves the engine half. This spec defines the product surface the engine plugs
into. The spike's Task 7 (shell decision memo) must treat the live-view and
ownership requirements in this spec as acceptance criteria, and the memo is the
gate before the desktop integration phase is planned.
