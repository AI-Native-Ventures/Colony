# Channel Workspace Docked Pane Design

Date: 2026-08-10
Status: Approved
Supersedes: the main-column replacement layout in
`2026-08-07-colony-channel-browser-workspace-design.md`

## Outcome

The channel workspace is an additional, resizable pane at the far right of the
desktop channel layout. Opening a browser, terminal, file, image, or scratchpad
tab never replaces the channel timeline and never covers an open thread.

The stable horizontal order is channel, thread when one is open, then workspace
when it is open. The sidebar remains outside this sequence. Workspace
fullscreen is an explicit temporary presentation, never the default result of
opening the workspace.

## User behavior

- The channel header control opens or closes the far-right workspace pane.
- With no thread open, the user sees Channel | Workspace.
- With a thread open, the user sees Channel | Thread | Workspace.
- The existing channel/thread divider and the workspace divider resize
  independently. Both preserve a usable channel width.
- Opening or closing a thread does not close or reset the workspace.
- Hiding the workspace preserves its tabs and active tab for the channel.
- Closing the last workspace tab closes the workspace pane. Reopening it shows
  the new-tab picker.
- The workspace expand control enters fullscreen by hiding the sidebar,
  channel, and thread without unmounting them. Collapse restores the same open
  panes and their prior widths.
- Workspace open/fullscreen state remains per channel. Workspace width is a
  device layout preference and persists for the desktop session.

## Layout architecture

`ChannelPane` remains the owner of the channel and existing auxiliary thread
surface. It adds `ChannelWorkspace` as the final flex-row sibling, after the
thread/profile/agent/channel-management auxiliary slot. The timeline and
composer remain mounted in the channel section while the workspace is open.

`ChannelContentSurface` no longer selects between timeline and workspace. It
is removed, or becomes a pass-through only if a small compatibility seam is
needed during the change.

A `RightWorkspacePane` component owns the far-right border, resize handle,
width, and workspace body. It follows the interaction and accessibility
patterns in `RightAuxiliaryPane` but does not share its mutually exclusive
occupant slot.

## Width coordination

The channel, auxiliary pane, and workspace share one flex-row container. The
workspace width hook clamps pointer movement against the measured container
width and the currently open auxiliary width, always reserving the shared
minimum width for the channel. The existing thread resize path applies the
same sibling-aware clamp when the workspace is open.

Default workspace width is 480px, minimum workspace width is 320px, and the
channel retains at least the existing 300px auxiliary-panel minimum. The
workspace width can grow to the remaining available space. Double-clicking its
divider resets the default width.

## State transitions

The persisted `timeline` / `workspace` value is reinterpreted as workspace pane
closed / open, keeping the existing storage key compatible. The channel header
button labels become `Open workspace` and `Close workspace`.

Expanded state remains per channel. Fullscreen changes visibility only; it
does not close threads, dispose tabs, stop native sessions, or rewrite widths.

When `ChannelWorkspace` closes the final tab, it closes the pane after the tab
kind's existing disposal completes. Closing the pane from the header does not
dispose tabs.

## Proof strategy

The implementation loop stays below one minute and uses the mock bridge:

- a channel-workspace Playwright test proves the timeline and composer remain
  visible beside the workspace;
- a thread-open case proves bounding-box order Channel < Thread < Workspace;
- pointer-driven tests prove the thread and workspace dividers resize
  independently and preserve minimum widths;
- a fullscreen round trip proves all other panes hide and return with the same
  widths;
- closing the final tab proves the workspace pane closes while the channel
  remains visible.

Engine input remains owned by the Chromium/WebKit Playwright projects. Browser
PID/profile cleanup remains owned by Rust real-Chromium lifecycle tests.
Packaged Flow 08 remains one real IPC/frame screenshot and must show the
channel beside the far-right browser pane.

## Out of scope

- Reordering panes or allowing arbitrary docking.
- A bottom workspace dock.
- Mobile workspace layout.
- Cookie import or browser identity work.
- Changing tab ownership, approvals, or persistence beyond the last-tab close
  transition.

## Acceptance criteria

1. Opening the workspace never replaces or unmounts the channel timeline.
2. An open thread remains visible between the channel and workspace.
3. Both dividers resize their pane independently without collapsing the
   channel below its minimum.
4. Fullscreen is explicit and collapse restores panes and widths exactly.
5. Closing the last workspace tab closes the workspace pane.
6. Focused mock-browser iteration remains under one minute.
