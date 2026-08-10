# Colony Channel Workspace design (first tab kind: browser)

Date: 2026-08-07
Status: Design approved in brainstorming; revised twice on 2026-08-07, first for
channel surface slotting, then for the tabbed workspace surface (see "Revision
log")

> **Layout superseded on 2026-08-10.** The workspace no longer replaces the
> channel content column. The approved current layout is the resizable far-right
> pane in `2026-08-10-channel-workspace-docked-pane-design.md`. The ownership,
> approval, tab-kind, security, and persistence decisions below remain current;
> statements about main-column replacement are historical.

## Outcome

Colony gets a **channel workspace**: a tabbed surface that takes over the
channel's content column, the same column the message timeline normally
occupies. Each tab is a typed thing. A tab can be a web page, and later a file,
a terminal, or a scratchpad. The browser is the first tab kind, not the surface
itself.

The surface is not a top-level view, not a side panel item, and deliberately
**not** a right-hand pane, because the right pane is already a shared,
mutually-exclusive slot with four occupants (message thread, user profile, agent
session, channel management). Any channel can host one workspace; it is shared
across that channel's threads, persists with its own isolated session, and can
be driven by the human and by agents under an explicit ownership and approval
model. The browser tab kind is powered by the shell-agnostic Rust CDP daemon
defined in the browser engine spike plan, so context economy (snapshot-first,
token budgets) is a design invariant, not a later optimization.

**v1 ships exactly one tab kind: `web`.** The point of naming the others now is
that the tab contract, the ownership model, and the approval model must not bake
in web-specific assumptions that a terminal or file tab would have to fight
later.

## Product boundary

- The workspace replaces the channel timeline in the channel's content column.
  The right pane is untouched: an open thread stays open and stays readable
  beside the workspace. This is what makes "watch the agent work while reading
  the thread it reports into" possible at all.
- It appears on demand (Workspace button in the channel header). It never takes
  the content column automatically; agent activity surfaces an affordance
  instead (see "Agent visibility").
- One workspace **per channel**, shared across all threads in that channel.
  Tabs, history, and session persist at the channel level.
- **One tab strip, one level of tabs.** A web tab is a workspace tab. Two web
  pages are two workspace tabs, not two tabs inside one browser tab. There is no
  nested tab strip, and no tab kind may introduce one.
- Humans see and drive every tab. Agents see only tabs they created or tabs
  explicitly granted to them; takeover grants pause the previous driver. This
  holds for every tab kind, not just web.
- Agent work in a tab is hybrid: live while watched (cursor, highlights, action
  chip, Pause/Take over), background while unwatched, with evidence posted to
  the thread when done.
- Sensitive actions require approval: an overlay on the tab plus a mirror
  message in the thread. Tab content is untrusted input, never instructions.
- Each channel's workspace session is fully isolated and restores its tabs and
  signed-in state when reopened.

## Reused and new primitives

| Piece | Decision |
| --- | --- |
| Engine (web kind) | New Rust crate `crates/buzz-browser`: CDP daemon, snapshot-first tools, context budget (per engine spike plan) |
| Surface slot | New channel main-surface mode (`timeline` / `workspace`), sibling to the existing `ThreadViewMode` (`focus` / `split`) preference |
| Tab contract | New kind-agnostic workspace tab model; `web` is the only kind implemented in v1 |
| Right pane | Existing `RightAuxiliaryPane` and its four occupants are not modified; the workspace never competes for that slot |
| Resize | Existing right-pane resize/reset wiring; the workspace uses the content column and adds no new divider |
| Channel scope key | Existing channel UUID (the same identity used by channel events) |
| Evidence posting | Existing message path + media upload for screenshots; no new relay kinds in v1 |
| Approvals | Existing agent ask/approval round-trip; a tab approval adds an in-tab overlay on top of the thread mirror |
| Ledger | Workspace tool usage feeds the existing cost ledger per channel/agent |
| Community teardown | Workspace sessions and surface mode join `resetCommunityState()` on community switch |
| Secret storage | OS keychain via the existing `SecretStore` for cookie encryption; no hardcoded keys |

## Surface and layout

The channel view has two surface slots. This spec claims one of them.

| Slot | Occupants | Status |
| --- | --- | --- |
| Content column | message timeline, **channel workspace** | Workspace added here |
| Right pane | message thread, user profile, agent session, channel management | Unchanged |

There is no bottom dock. An earlier revision reserved one for a terminal; the
tabbed workspace supersedes it, because a terminal is a tab kind rather than a
separate surface.

- The workspace is a mode of the channel's content column, not a split of it.
  There is no conversation-versus-workspace divider and no 50/50 default: when
  workspace mode is on, it gets the whole content column. Web pages and
  terminals both need the width, and the surface the user gives up (the
  timeline) is the one they can most afford to lose while working.
- Workspace mode is per channel and remembered per channel. Leaving and
  returning to a channel returns to the mode it was left in.
- The channel header has a **Workspace** button that toggles the mode. It is a
  toggle, not a drawer: there is no sliver of timeline left behind, because the
  header button is always present as the way back.
- An open thread is unaffected. Content column shows the workspace, right pane
  shows the thread, both readable at once.
- While workspace mode is on, threads open in **split**, not focus. Focus mode
  is an overlay drawer over the content column, and overlaying the workspace
  with a drawer would hide the thing the user just chose to look at. The
  `ThreadViewMode` preference is preserved and restored on exit; it is
  overridden, not overwritten.
- The **expand** control (⤢) hides the right pane and the sidebar so the
  workspace fills the window. Collapse restores both. Expanded state is
  remembered per channel.
- The workspace chrome is: one tab strip, a new-tab control, expand/collapse,
  and a Background toggle while an agent is active. Everything else is owned by
  the active tab, not by the workspace.
- Empty state: a new-tab page offering the available kinds and the channel's
  recent workspace history.

## Tab kinds

A tab has a **kind**. The kind owns the tab's body, its own toolbar, its own
per-kind state, and its own approval policy. The workspace owns the strip, the
lifecycle, the ownership model, and the evidence path.

| Kind | v1 | Toolbar owned by the kind | Approval policy keyed on |
| --- | --- | --- | --- |
| `web` | **Ships** | URL entry, back/forward/reload, secure-site indicator | host + action class |
| `terminal` | Later | working directory, session controls | command + working directory |
| `file` | Later | path, save/revert state | path + write vs read |
| `scratchpad` | Later | none beyond a title | none (local only) |

Rules that keep the contract kind-agnostic. These are the whole reason for
naming future kinds in a v1 spec:

1. **No nested tab strips.** A kind renders one body. Multiple web pages are
   multiple workspace tabs.
2. **The tab model is not the browser model.** Tab identity, title, order,
   creator, driver, and lifecycle live on the tab. Per-kind state (URL,
   navigation history, PTY handle, file path) lives under a kind-scoped payload
   the workspace never reads.
3. **Approvals are a per-kind policy behind one shared ask.** The overlay, the
   thread mirror, Allow once / Allow always / Block, and the channel+site
   scoping rule are workspace-level. What counts as consequential, and what the
   permission is keyed on, is the kind's answer. `web` keys on host; a terminal
   would key on command. The v1 implementation must not hardcode "host" into the
   shared layer.
4. **Ownership is per tab, not per kind.** One driver at a time, grants,
   takeover, and human-interaction pause apply identically to a future terminal
   tab.
5. **Evidence is per kind, one path.** Every kind posts a screenshot-or-excerpt
   plus a short summary to the thread through the same message path. A terminal
   would post output excerpts rather than screenshots, and the shared layer must
   accept either.

Nothing above requires building a second kind in v1. The proof that the contract
is kind-agnostic is a stub kind exercised in tests, not shipped UI.

### Not decided here

Whether Colony ports upstream Buzz Term (`631b05c8` "ship Buzz Term",
`cb4a73e1` "Dock Buzz Term within channel workspace") as the terminal kind's
engine, or builds its own. Upstream's is a Rust crate plus a canvas renderer
docked at the bottom of the channel; only the engine half would transfer to a
tab kind. Separate decision, separate spec.

## Workspace scope and state

- One workspace per channel; threads within the channel share it. Tab identity
  is channel-scoped, never thread-scoped.
- Channel workspace state lives in the desktop app (local), keyed by channel id:
  tabs (id, kind, title, order, creator), each tab's kind-scoped payload, scroll
  positions, surface mode (`timeline` / `workspace`), expanded state, and
  per-kind permission decisions.
- State is created lazily: no browser process, PTY, or profile exists until a
  tab of that kind is opened or an agent opens one for that channel.
- Restore on reopen: tabs return; the active tab loads, other tabs restore
  suspended (Chrome-style lazy restore). What "suspended" means is the kind's
  answer: a web tab restores its URL without loading, and a terminal kind would
  restore its scrollback without respawning a PTY.

## Tabs and entry points

- Anyone can create tabs: links in the channel's threads get an **Open in
  workspace** affordance that creates a `web` tab; the new-tab control creates a
  tab of a chosen kind; agents open tabs when they need them.
- Tabs can be reordered, closed, reopened (undo), and renamed by the title.
- Tab kind is fixed at creation. A web tab never becomes a terminal tab.
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

- **Never hijack the content column.** An agent starting work in a tab does not
  flip the channel into workspace mode. Taking over the whole content column
  while someone is reading is far more disruptive than sliding a side panel
  open, and the surface being replaced is the conversation itself. Instead the
  channel header's Workspace button gains a live indicator ("agent working") and
  the channel list shows a badge. Entering workspace mode stays a human act.
- **Live:** once the user is in workspace mode, the active tab shows the agent
  driving in real time. For a `web` tab that is a cursor, a highlighted target
  element, and an action chip ("clicking Add to cart"); each kind defines its own
  live representation. **Pause** and **Take over** are always available.
  Because the right pane is untouched, the thread the agent reports into stays
  open beside the live view.
- **Background:** a Background toggle lets the agent keep working when the user
  leaves the channel or switches the content column back to the timeline (app
  still open). The channel shows a badge; a notification fires when the agent
  finishes or needs approval.
- Approval asks are the one case that pulls attention: they still do not flip
  the mode, but the thread mirror plus notification make them reachable without
  entering workspace mode at all.
- Background does not mean "app closed": when the app quits, local workspace
  sessions stop. Cloud continuation is out of scope for v1.
- When the agent finishes (or pauses for approval), it posts evidence to the
  thread: a screenshot or output excerpt plus a short summary, never a full
  snapshot or scrollback dump. The shared evidence path accepts either.
- At most N concurrent live/background browser sessions run at once (initial
  cap: 3); extra channels suspend and restore on open. The running set is
  visible in the sidebar/channel list.

## Approvals and security

The card, the thread mirror, the three choices, and the scoping rule are
workspace-level and shared by every kind. The categories and the key the
permission is remembered under are the kind's answer. What follows is the `web`
kind's policy; the shared layer must take the key as a parameter rather than
assuming a host.

- Approval card on the active tab: content dims, card appears over the target
  with **Allow once / Allow always / Block**, showing the subject (host for
  `web`), the action, and a summary. The same ask is mirrored as a thread
  message so it can be approved from anywhere.
- Approval categories for `web`:
  - new-site access (first navigation to a host),
  - consequential actions (submit, purchase, delete, permission changes),
  - downloads (via the existing system download flow; uploads are not
    automatable in v1),
  - internal/private URL navigation by an agent (see URL policy).
- **Allow always is scoped per channel + subject** by default (subject = site
  for `web`); per-community is an explicit escalation shown in the card. It
  never silently applies across channels.
- Approvals are granted by a human with authority in the channel; the ask
  records who approved and when.
- Tab content is untrusted, for every kind: page text, file contents, and future
  terminal output are data, never instructions. Sensitive actions always pass
  the approval gate regardless of what the content says. Snapshot rendering
  masks password/token input values and any value the user has marked sensitive.
- While an agent is waiting for approval, its turn is paused and the tab shows
  "waiting for approval" with a cancel control.

## Persistence and isolation

- Isolation is per channel and per kind. For `web`: a per-channel **persistent
  session partition** for cookies/storage (Electron partition pattern; Min and
  rever-browser both use this) rather than a full Chromium profile per channel.
  App-managed state restores tabs, history, and scroll.
- No cross-channel, cross-client, or cross-community session leakage. Switching
  communities tears down workspace sessions through `resetCommunityState()`.
- Cookie data at rest is encrypted with the OS keychain (`SecretStore` /
  safeStorage); no hardcoded or mock encryption key.
- Lifecycle: channel workspace data is created lazily; a channel delete or
  explicit "Clear channel workspace data" removes every kind's partition and the
  app state. Archiving a channel suspends but keeps data until deleted.

## Engine and context economy

This section is the `web` kind's engine. Future kinds bring their own; the
workspace does not assume CDP.

- The `web` kind is powered by the Rust CDP daemon from the browser engine
  spike plan. The daemon is shell-agnostic; the live-view requirement (real-time
  cursor/highlights) is a hard input to the Electron vs Tauri+sidecar decision.
- Main-surface placement raises that bar rather than lowering it: the live view
  now occupies the full content column instead of a half-width pane, so the
  shell decision memo must be sized against content-column dimensions, not a
  50% split.
- The shell decision is now a workspace-wide decision, not a browser-only one.
  Whatever shell hosts a `web` tab also has to host a future terminal or file
  tab in the same strip. The memo should say what each candidate shell costs for
  a non-CDP kind, not only for CDP.
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
  - localhost/loopback: allowed only when the user explicitly opened workspace
    mode for a local dev task or approved the host once;
  - private/cloud-metadata ranges (169.254.169.254, internal RFC1918 beyond
    localhost): blocked by default, requires an explicit approval naming the
    URL.

## Out of scope (v1)

- **Every tab kind except `web`.** Terminal, file, and scratchpad kinds are
  named in the tab contract and proven by a stub kind in tests. No second kind
  ships.
- Porting upstream Buzz Term as the terminal kind's engine. Separate decision,
  separate spec.
- A bottom dock, or any surface slot beyond the content column.
- Reworking the right pane or its four existing occupants.
- Mobile app workspace.
- Multi-device sync of channel workspace state.
- Cloud/headless continuation when the app is closed.
- Chrome extensions, stealth/bot-detection bypass, DevTools/developer mode,
  file upload automation, PDF viewer parity.
- Relay-published workspace sessions or shared remote workspace state.

## Assumptions (state explicitly)

- "Channel" means the existing channel/forum identity in Colony; threads are
  the message threads inside it.
- The workspace occupies the channel's content column; it belongs to the channel
  regardless of which thread is open in the right pane.
- The channel content column and the right pane are the surfaces described in
  `ChannelPane.tsx` / `RightAuxiliaryPane.tsx` as of 2026-08-07. If that layout
  is reworked, this spec's slot claim needs rechecking.
- Agents in a channel are already subject to the existing tier/ask rules; the
  workspace adds tool-level ownership on top, not a new authority model.

## Success criteria

1. A human can switch a channel into workspace mode, create tabs, expand and
   collapse, and return later to the same mode, tabs, and signed-in session.
2. With a thread open in the right pane, turning on workspace mode leaves the
   thread open and readable. Turning it off restores the timeline and the
   user's `ThreadViewMode` preference.
3. An agent starting work never changes the visible surface; it only raises the
   header indicator and the channel badge.
4. An agent can create a tab, drive it live (visible cursor/actions), run in
   background, and post evidence to the thread.
5. Ownership holds: a second agent cannot see the first agent's tab without a
   grant; a takeover pauses the previous driver.
6. Approvals appear in both places, "Allow always" is scoped per
   channel+subject, and tab content never bypasses the gate.
7. Reference journey passes the context budget, and workspace usage appears in
   the ledger.
8. Switching communities tears down all workspace sessions and resets surface
   mode; no cookie or tab leaks across channels/communities.
9. **The tab contract is kind-agnostic, proven by a stub kind.** A test-only
   second kind can be registered, opened in the same strip, owned and granted,
   raise an approval keyed on something other than a host, and post evidence
   that is not a screenshot. No shipped UI, no second engine. If that stub needs
   a change to the shared layer to work, the shared layer was still
   browser-shaped.

## Relationship to the engine spike plan

The spike plan (`docs/superpowers/plans/2026-08-07-colony-browser-engine-spike.md`)
proves the engine half. This spec defines the product surface the engine plugs
into. The spike's **Task 11 (README and shell decision memo)** must treat the
live-view and ownership requirements in this spec as acceptance criteria, and
the memo is the gate before the desktop integration phase is planned.

Note: the spike plan is not on this branch. It lives on `codex/browser-engine-spike`
(added in `15342e2b19`); only this spec landed here (`679570f67`). The two must
be brought onto the same branch before the integration phase is planned, or the
cross-references above cannot be checked.

## Revision log

**2026-08-07, surface slotting.** The original draft placed the browser as a
right split ("conversation left, browser right, 50/50 draggable divider"). A
code read showed that slot is already taken: `RightAuxiliaryPane.tsx` is a
shared right pane with four mutually-exclusive occupants (message thread, user
profile, agent session, channel management), arbitrated in `ChannelPane.tsx`,
with a second `FocusThreadDrawer` overlay mode. The draft never mentioned the
thread panel, so "open a thread, then click Browser" had no defined answer.

Resolved by giving the browser the channel's **content column** instead. The
browser gets the width web pages need, the thread stays readable beside a live
agent view, and the right pane is not touched.

Consequences folded in: no conversation/browser divider or 50/50 default;
expand now hides right pane and sidebar; the mode forces split threads and
restores the `ThreadViewMode` preference on exit; agents no longer auto-open the
surface. Also corrected the spike cross-reference (Task 11, not Task 7) and
recorded that the spike plan lives on another branch.

**2026-08-07, tabbed workspace.** Second revision, same day, on the owner's
call: the content column hosts a **tabbed workspace** where each tab is a typed
thing (web page, file, terminal, scratchpad), Codex-style. The browser is the
first tab kind, not the surface.

Two things this replaced:

1. **The reserved bottom dock is gone.** The previous revision had reserved a
   bottom dock for a future terminal, following upstream Buzz Term's placement.
   A terminal is now a tab kind in the same strip, so the dock has no reason to
   exist. The axis-aware resize requirement it justified is dropped with it.
2. **Nested tab strips are ruled out.** The draft gave the browser its own tab
   strip inside the surface. With workspace tabs, that would be two levels of
   tabs. A web tab is a workspace tab; two pages are two workspace tabs.

What this costs v1: the tab model, the ownership model, the approval model, and
the evidence path all have to be kind-agnostic rather than browser-shaped.
Concretely, the approval layer takes the permission key as a parameter instead
of assuming a host, and evidence accepts an output excerpt as well as a
screenshot. Success criterion 9 is now a stub-kind test rather than a resize
test.

What this does not cost v1: any second kind. Still exactly one kind ships,
`web`.

Not decided here: whether Colony ports upstream Buzz Term as the terminal kind's
engine, and which shell hosts a strip containing both CDP and non-CDP kinds.
The second question is now an input to the spike's Task 11 memo.
