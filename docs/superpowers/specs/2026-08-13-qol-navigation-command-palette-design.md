# QoL Navigation: Command Palette Design

**Status:** Implemented in the first navigation slice

## Problem

The desktop app already has global search behind `⌘K`/`Ctrl+K`, but the search dialog only helps when the user remembers a channel, person, or message. Moving between the app's primary surfaces still requires finding the sidebar item or knowing a separate shortcut.

## Decision

Turn the existing search dialog into a command-capable quick switcher rather than adding a second palette. It keeps the same trigger, focus behavior, result keyboard navigation, and relay-backed search. Commands are represented as typed results with stable ids, labels, descriptions, icons, and callbacks.

The empty state shows recent channel activity followed by Actions. Once a query is entered, matching commands and relay results are shown together. Commands are filtered locally by title and description; channel, person, and message search continues through the existing search hook. Selecting a command closes the dialog through the existing exit-animation helper, then invokes the callback.

## Command set

Always available:

- Open inbox
- Open agents
- New direct message
- Browse channels
- Open settings
- Create a new channel
- Create a new agent
- Open Blocks
- Open Spend
- Open Discovery

Preview-gated commands are added only when their existing feature is enabled:

- Open Pulse (`pulse`)
- Open Projects (`projects`)
- Open Workflows (`workflows`)

The existing create/browse callbacks remain as fallbacks for callers that render `TopbarSearch` without the AppShell command list. Duplicate ids are suppressed so those callers do not produce duplicate rows.

## Architecture

- `desktop/src/app/navigation/navigationCommands.ts` owns the command catalog and preview-gate filtering. It is pure to test and exposes a small hook that memoizes callback-bearing command objects.
- `AppShell` supplies existing navigation and dialog callbacks; no route or backend API is added.
- `TopbarSearch` merges command results with the existing `SearchResult` union and uses the existing `openAfterExit` path.
- `SearchResultItem` owns the stable command id union and icon mapping.

## Accessibility and interaction

- The existing `⌘K`/`Ctrl+K` listener opens the dialog and focuses its input.
- Arrow keys, Enter, Escape, `aria-selected`, and `role=option` remain handled by the existing dialog implementation.
- The keyboard-shortcut settings copy now describes both search and navigation.

## Acceptance criteria

- `⌘K`/`Ctrl+K` opens the existing dialog.
- Empty state contains Actions after recent activity.
- Typing `settings` shows only the matching settings command among command rows.
- Enter on the selected command navigates to the destination after the dialog exits.
- Typing a channel name still returns and opens the existing channel result.
- Disabled preview features do not add their commands.
- No terminal/workspace behavior changes.

## Validation

- `desktop/src/app/navigation/navigationCommands.test.mjs` covers enabled/disabled command catalogs and callback delegation.
- `desktop/tests/e2e/navigation-command-palette.spec.ts` covers real shortcut opening, command filtering/selection, route navigation, and channel-result preservation.
