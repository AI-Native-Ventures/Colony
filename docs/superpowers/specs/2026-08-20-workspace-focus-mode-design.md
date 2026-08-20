# Workspace Focus Mode, Direct Navigation, and Artifact Delivery Design

Date: 2026-08-20
Status: In review after artifact-delivery amendment
Thread: `ec0cd9f47806fd60419bffb14971223e29a0fc671a49c248d448cd4ec86107f0`

## Outcome

Opening a channel workspace creates one focused working surface instead of a
four-column layout. When a thread is open, the thread remains visible on the
left and the workspace owns the rest of the window. When no thread is open,
the workspace uses the full content area.

Clicking a supported web link in a channel message opens the target page
immediately in the workspace browser. The Web tab must not require a second
`Open site`, `Launch`, or connection click.

The ordinary collapsed sidebar also becomes a complete collapse. Community,
company-switcher, profile, footer, and sidebar content must not spill into the
remaining application surface.

Files and documents delivered in a channel must be first-class message
attachments. A repository or machine-local path is never sufficient as the
only user-facing deliverable. Clicking the attachment opens it directly in the
channel workspace and enters the same focus layout without an intermediate
open step. Opening means the document content is visible, not merely that a
tab displays a binary-file placeholder.

## Problems being solved

1. Sidebar, channel, thread, and workspace currently compete for horizontal
   space.
2. Workspace fullscreen hides the thread, which removes the context the user
   needs while acting on work from that thread.
3. A clicked message link creates a Web tab with the right URL but leaves the
   browser disconnected until the user performs another action.
4. Collapsing the sidebar can leave community or switcher content visible,
   making the layout look unfinished.
5. Entering and leaving workspace modes must not lose drafts, scroll position,
   tab state, or browser sessions.
6. Agent-generated documents can currently be described with local paths that
   the recipient cannot open, so the message appears to contain a deliverable
   while providing no usable artifact.

## Selected approach

The approved approach is **Focus split**.

- Workspace open with a thread: `Thread 20% | Workspace 80%`.
- Workspace open without a thread: `Workspace 100%`.
- Sidebar and channel are hidden while the workspace is open.
- The thread and workspace remain sibling panes, not overlays.
- The divider is draggable.
- Double-clicking the divider resets the split to 20/80.
- A Back to conversation control closes the workspace surface and restores the
  exact prior conversation layout.

The rejected alternatives were a thread drawer over a full-width workspace and
retaining sidebar, channel, thread, and workspace together. The drawer obscures
workspace content. The four-pane layout preserves maximum context but produces
the crowding that triggered this work.

## Product modes

### Conversation mode

- The normal sidebar and channel layout is visible.
- An open thread stays visible in its current split or focus presentation.
- Workspace tabs and native sessions may exist but the workspace pane is
  hidden.
- Collapsing the sidebar removes the entire sidebar surface, including the
  community rail and profile or switcher controls. The top chrome sidebar
  trigger remains available.

### Workspace focus mode with a thread

- Sidebar and community rail are hidden.
- The channel timeline and composer are hidden.
- The open thread stays mounted and visible on the left.
- The workspace stays mounted and visible on the right.
- The initial split is 20/80 of the available content width.
- The thread has a 280px minimum width.
- The workspace retains its existing 320px minimum width.
- At supported desktop widths, the divider clamps so both minimums remain
  satisfied and the workspace receives the width left after the thread.
- The user-adjusted focus split persists for the current desktop session.
- The focus split preference is separate from the ordinary conversation thread
  width and never overwrites it.
- Double-click resets the preferred split to 20/80.

### Workspace focus mode without a thread

- Sidebar, community rail, and channel are hidden.
- Workspace uses 100% of the available content width.
- Opening a thread while focus mode remains active transitions to the 20/80
  split without restarting or remounting the workspace.
- Closing the thread while focus mode remains active returns the workspace to
  100% width.

## Orientation and exit controls

The channel is hidden in focus mode, so the thread header must retain context.

- Show the channel name in the thread header.
- Show the thread root author and a short root-message snippet.
- Keep these labels compact and truncated rather than adding another toolbar.
- The channel label exits focus mode and returns to the conversation while
  keeping the thread open.

The workspace tab strip includes a visible `Back to conversation` control.
It replaces the current expand or collapse affordance because workspace-open
is now the focus state. Activating it:

1. switches the channel surface back to conversation mode;
2. reveals the sidebar according to its prior open or collapsed state;
3. reveals the channel and its existing open thread;
4. preserves workspace tabs, their active tab, browser sessions, drafts,
   scroll positions, and pane preferences.

Closing the last workspace tab also returns to conversation mode after the
tab-kind disposal completes.

## Direct link behavior

The existing channel-scoped `WorkspaceLinkProvider` remains the entry point
for message links. Links outside a channel workspace keep their current
behavior.

For a clicked HTTP or HTTPS link in a channel:

1. Parse and canonicalize the URL with the existing safe URL policy.
2. Search Web tabs owned by the current channel for the same canonical URL.
3. If a match exists, activate that tab.
4. Otherwise create a Web tab with the canonical URL as its payload.
5. Switch the channel into workspace focus mode.
6. Start the native Web session immediately when the active Web body mounts.
7. Focus the browser surface after the initial frame is ready without moving
   focus to a visible external application.

Deduplication is scoped to the current channel. A matching URL in another
channel is not reused because workspace tabs and their context are
channel-owned.

The exact canonical URL is the deduplication key. Different paths, queries, or
fragments remain distinct tabs.

Right-click and modifier behaviors retain their existing actions, including
copying the address or opening the link with the operating system when that
action is explicitly selected.

## First-class document and artifact delivery

Any file presented as a deliverable in a channel or thread must be sent as a
message attachment with its relay-backed reference and metadata. A local file
path may appear as secondary technical context, but it must never be the only
way the recipient is expected to open the result.

For a clicked message attachment in a channel:

1. Resolve the attachment from the signed message metadata, including its
   relay URL, filename, media type, size, and content hash when available.
2. Reuse an existing matching File tab in the current channel or create one.
3. Switch the channel into workspace focus mode.
4. Load the document immediately in the workspace file viewer.
5. Keep any open thread visible at the left under the same 20/80 rules.

The attachment remains bound to the originating channel and thread message so
the recipient can return to its conversational context. An unreadable,
missing, or rejected attachment stays in the File tab with a clear error and a
Retry action. It must not silently fall back to a sender-only local path or be
presented as successfully delivered.

The send path is responsible for uploading a local file before publishing the
message and including the attachment metadata in the signed event. Existing
same-machine workspace-path opening remains available as a convenience, but it
is not cross-session delivery and does not satisfy this contract by itself.

The current source has a generic relay upload path and message File cards, but
the shipped `buzz messages send --file` client rejects both Markdown and PDF
before upload. The CLI also formats every non-video upload as image Markdown.
This client gap is part of the implementation scope:

- accept generic non-media files under the existing safe size cap and relay
  deny-list policy while preserving the strict image, video, and audio rules;
- upload generic files through the existing `/upload` route, with no fallback
  to the legacy media-only route;
- preserve the original filename in the signed `imeta` metadata;
- emit a normal filename link for generic files so the desktop renderer creates
  a File card instead of treating the document as an image;
- keep Markdown readable even when byte sniffing reports
  `application/octet-stream`, using the trusted filename only to select the
  inert text viewer after the relay has stored the bytes as a download;
- render PDF content inside the File tab rather than showing the current
  `is not a text file` placeholder.

An existing unmerged CLI change for generic uploads may be reused after review
and rebasing, but its existence is not proof that the installed client or live
relay supports document delivery.

## Web tab startup and error states

A Web tab created from a message link has a non-blank URL payload. `WebBody`
must automatically call the existing native session start path for that tab.
Manual Web tabs created from the workspace new-tab page may continue to show
the blank browser state until the user enters a URL.

Startup states remain inside the Web tab:

- **Connecting:** keep the browser toolbar visible and show a calm loading
  state in the page surface.
- **Running:** show the first frame and focus the browser surface.
- **Failed:** keep focus mode and the tab intact, show the error in the page
  surface, and provide Retry.
- **Retry:** rerun the same safe session request for the tab. It must not create
  a duplicate tab.

Unsafe schemes, URLs containing credentials, and unsupported build variants
continue to follow the existing rejection or operating-system fallback path.
No unsafe URL is sent to the native browser manager.

## State model

`ChannelSurfaceMode` remains the channel-level source of truth:

- `timeline` means conversation mode;
- `workspace` means workspace focus mode.

The separate persisted workspace-expanded state is no longer a third product
mode. Existing stored expanded values are ignored after the migration and may
be removed from storage on the first state write.

Focus mode changes visibility and geometry only. It must not dispose or
unmount:

- the channel timeline;
- the channel composer;
- the open thread;
- thread or channel drafts;
- workspace tabs;
- Web, terminal, or other native workspace sessions.

The existing community reset boundary continues to clear channel surface
modes and workspace state. Any new module-level preference or URL index must
also be reset by the existing community reset path.

## Component ownership

### `AppShell`

- Derives whether the active channel is in workspace focus mode.
- Hides `AppSidebar` and `CommunityRail` while focus mode is active.
- Does not mutate the user's ordinary sidebar open or collapsed preference.

### Sidebar surface

- Treats the ordinary collapsed state as a complete off-canvas state.
- Ensures the community rail, profile card, company switcher, sidebar footer,
  and their hit targets do not remain visible or reserve width.
- Leaves only the top chrome toggle as the way back into the sidebar.

### `ChannelPane`

- Owns the visibility of channel, thread, and workspace siblings.
- Keeps the channel section mounted but hidden in workspace focus mode.
- Keeps an open thread mounted and visible in workspace focus mode.
- Passes thread presence and focus geometry to the workspace dock.

### `ChannelWorkspaceDock` and workspace pane

- Own the 20/80 split, minimum widths, drag behavior, and reset behavior.
- Render 100% workspace width when no thread is open.
- Remove the old all-other-panes-hidden fullscreen presentation.
- Expose a clear Back to conversation action through the workspace tab strip.

### `WorkspaceLinkProvider` and URL opener

- Preserve current safe-URL parsing and channel scoping.
- Add exact canonical URL lookup among current-channel Web tabs.
- Activate a matching tab or create a new tab.
- Enter workspace focus mode after a successful open or reuse decision.

### Message attachments and file opener

- Treat relay-backed attachment metadata as the canonical delivery reference.
- Reuse or create the matching current-channel File tab on attachment click.
- Enter workspace focus mode and load the file without an intermediate action.
- Keep sender-local path opening as a separate same-machine convenience.
- Show loading, failure, and Retry inside the File tab.
- Render safe text and Markdown directly in the File tab.
- Render PDF pages directly in the File tab with download remaining available.

### `buzz` CLI upload and message sender

- Allow generic non-media attachments under the existing file size and relay
  deny-list policy.
- Keep unsupported media types rejected rather than treating them as generic
  binary files.
- Include the original filename in `imeta` alongside URL, MIME, hash, and size.
- Use plain filename-link Markdown for generic files and media Markdown only
  for supported images and video.
- Do not report message delivery when the upload step has failed.

### Web tab body and session manager

- Auto-start a Web session for a link-created non-blank URL.
- Keep the existing single-start and generation guards so React remounts do
  not create duplicate native sessions.
- Add an in-surface Retry action for failed starts.
- Keep loading and failure state local to the tab.

## Accessibility and interaction details

- Back to conversation is a labeled button with a stable accessible name.
- The focus divider remains keyboard-focusable and pointer-draggable.
- Double-click reset retains its current discoverable title.
- Hidden surfaces use both visual hiding and interaction suppression so they
  cannot receive pointer or keyboard events.
- Mode transitions restore focus to the most recent meaningful target:
  browser surface when entering focus mode, thread composer when returning to
  an active thread, otherwise channel composer.
- Thread header context and browser status use existing rem-based text tokens.
- No new fixed-pixel text sizes are introduced.

## Proof strategy

### Unit coverage

Extend or add desktop unit tests for:

- channel surface transitions for workspace with and without a thread;
- 20/80 ratio calculation and both pane minimums;
- session preference and double-click reset behavior;
- canonical exact-URL reuse within one channel;
- no reuse across channels or for different URL paths, queries, or fragments;
- auto-start only for non-blank link-created Web tabs;
- failed start and Retry using the same tab;
- community reset clearing any new workspace-focus singleton state;
- attachment identity and current-channel File-tab reuse;
- rejection of a path-only value as cross-session delivery evidence;
- attachment loading failure and Retry in the same File tab;
- CLI acceptance of Markdown and PDF through the generic upload path;
- CLI rejection of unsupported image, video, audio, and executable types;
- filename-preserving `imeta` and plain-link message formatting;
- Markdown MIME fallback and direct PDF rendering.

Run the full desktop package test command:

```bash
cd desktop && pnpm test
```

Also run desktop typecheck and checks:

```bash
cd desktop && pnpm typecheck && pnpm check
```

Run the full affected Rust package suites:

```bash
cargo test -p buzz-cli
cargo test -p buzz-media
cargo test -p buzz-relay
```

### Playwright coverage

Update the existing channel-workspace and workspace-message-link flows to
prove:

1. Collapsing the sidebar leaves no sidebar or community-switcher pixels,
   width, or interactive hit targets.
2. Clicking a message link opens the selected URL, enters focus mode, and does
   not require a second connect or Open site action.
3. With a thread open, channel and sidebar are hidden while thread and
   workspace occupy the expected order and approximate 20/80 geometry.
4. Without a thread, the workspace occupies the full content width.
5. Opening and closing a thread during focus mode transitions between those
   layouts without restarting the Web session.
6. Reopening an exact URL activates one existing tab instead of creating a
   duplicate.
7. Back to conversation restores sidebar state, channel, thread, pane widths,
   thread anchor, drafts, active tab, and browser state.
8. A failed browser start stays inside the Web tab and Retry succeeds without
   a duplicate tab.
9. The focus layout remains usable at 1600x900, 1280x720, and a narrower
   supported desktop viewport.
10. Clicking a real message attachment opens its File tab immediately in focus
    mode while retaining the originating thread.
11. A sender-only local path is not rendered or reported as a successfully
    delivered cross-session artifact.
12. The same flow works for a Markdown file detected as
    `application/octet-stream` and for an `application/pdf` file.

All E2E builds use `pnpm build:e2e` through the package scripts. Screenshots
wait for animations and are visually inspected for crowding, clipped controls,
and broken hierarchy.

### Real packaged proof

Run the packaged Tauri Web-tab flow against a safe test URL. The proof must
show:

- one click in a real message;
- immediate workspace focus mode;
- a real native browser session starting without another user action;
- the requested URL producing a live frame;
- the thread remaining visible at the left when one is open;
- Back to conversation restoring the prior layout;
- native browser cleanup when the tab is closed.

Mock Playwright proof and packaged native proof remain separate evidence.

### Real attachment proof

Send the design document itself into the originating Product thread through
the production attachment path. The proof must show:

- the published message contains a first-class attachment card rather than
  only a local path;
- the signed message carries the attachment metadata;
- clicking the card from the receiving session opens the document directly in
  a File workspace tab;
- the Markdown source renders as readable text and the PDF renders as pages;
- the attachment remains associated with the originating thread;
- the sender's local repository path is not required by the receiver;
- a missing attachment produces an in-tab failure with Retry.

Successful upload and message acceptance prove delivery to the thread. They do
not prove recipient openability until the attachment is clicked from a
receiving session.

## Acceptance criteria

1. Ordinary sidebar collapse leaves no community, switcher, profile, footer,
   width, or hit-target spill.
2. Opening the workspace always hides the sidebar and channel.
3. An open thread remains visible beside the workspace at a default 20/80
   split, subject only to pane minimums.
4. With no thread open, workspace uses 100% of the content width.
5. The focus divider is draggable and double-click resets to 20/80.
6. Clicking a supported message link starts and loads the native workspace
   browser without a second action.
7. An exact URL already open in the current channel activates its existing tab.
8. Thread orientation shows channel and root context while the channel is
   hidden.
9. Loading, failure, and Retry stay inside the Web tab and never eject the user
   from focus mode.
10. Back to conversation restores the exact prior conversation state without
    losing drafts, scroll positions, tabs, or native sessions.
11. A delivered document appears as a relay-backed message attachment and
    opens directly in a current-channel File tab without relying on a local
    path or requiring another open action.
12. Attachment loading and failure stay inside the File tab, and the artifact
    remains bound to its originating channel and thread.
13. Markdown and PDF uploads both produce filename-preserving attachment cards,
    and their content is visible directly in the File tab.
14. Desktop package tests, CLI and relay package tests, targeted Playwright
    flows, real attachment proof,
    and real packaged Tauri proof pass at the same commit before the
    implementation is called proven.

## Out of scope

- Mobile workspace layout.
- Arbitrary pane reordering or docking.
- A bottom workspace dock.
- Multiple simultaneous workspaces for one channel.
- Browser cookie import or identity changes.
- New relay events, schema changes, or upload APIs. The existing generic upload
  path is reused and its deployed adoption is verified.
- Converting arbitrary inline code paths into attachments after a message has
  already been published.
- Changing workspace tab ownership across channels.
- New permanent navigation beyond thread orientation and Back to conversation.
