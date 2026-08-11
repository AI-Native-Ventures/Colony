# Channel Workspace Docked Pane Implementation Plan

> Execute inline with focused, sub-minute mock-browser iterations. Do not run a
> packaged Tauri rebuild and do not start cookie import in this phase.

**Goal:** Keep the channel and any open thread visible while a resizable
workspace pane docks at the far right, with explicit fullscreen and last-tab
close behavior.

**Architecture:** `ChannelPane` remains the horizontal layout owner. The
message surface stays mounted in its main section, the existing auxiliary pane
remains the middle sibling, and a new `RightWorkspacePane` is rendered last.
Workspace width is session-persisted and clamped against the measured channel
container plus any open auxiliary pane.

**Proof gate:** The focused `channel-workspace.spec.ts` mock-browser loop must
fail on the old replacement layout, then pass in under one minute after the
change. Web input and browser-process lifecycle retain their separate engine
and Rust proofs.

## Task 1: Lock the new behavior with failing browser tests

**Files:**
- Modify: `desktop/tests/e2e/channel-workspace.spec.ts`
- Modify: `desktop/tests/e2e/workspace-web.spec.ts`

Add direct geometry and visibility assertions for Channel | Thread |
Workspace ordering, independent workspace resize, fullscreen restoration, and
closing the last tab. Run only the focused workspace specs and capture the
expected failures against the current replacement implementation.

## Task 2: Add the dock and coordinated width model

**Files:**
- Add: `desktop/src/features/workspace/ui/RightWorkspacePane.tsx`
- Add: `desktop/src/features/workspace/ui/useWorkspacePanelWidth.ts`
- Modify: `desktop/src/features/channels/ui/RightAuxiliaryPane.tsx`
- Modify: `desktop/src/features/channels/ui/ChannelPane.tsx`
- Modify: `desktop/src/features/workspace/ui/ChannelContentSurface.tsx`

Make the content surface a message-only pass-through, render the workspace as
the last flex sibling, and reserve the channel/auxiliary minimum widths while
either divider is dragged. Keep the workspace split even at the former overlay
breakpoint so it never covers a thread.

## Task 3: Wire fullscreen and last-tab close

**Files:**
- Modify: `desktop/src/app/AppShell.tsx`
- Modify: `desktop/src/features/workspace/ui/ChannelWorkspace.tsx`
- Modify: `desktop/src/features/channels/ui/ChannelScreenHeader.tsx`

Hide, rather than dispose, sidebar/channel/thread surfaces during workspace
fullscreen. Restore the exact layout on collapse. After the final tab's normal
disposal completes, close the workspace pane and reset expanded state.

## Task 4: Prove and ship the focused change

Run the focused workspace Playwright specs, desktop type/lint checks relevant
to changed files, file-size and native-inventory checks. Record each iteration
time, commit with DCO signoff, push the rebased branch, and verify the remote
head with `git ls-remote --heads origin feat/workspace-web-tab`.
