# Appearance Custom Gradient Implementation Plan

**Goal:** Keep the existing Appearance page and Default appearance; replace the alternative theme tiles with Custom and two gradient color inputs.

**Architecture:** Both choices use the existing Buzz light/dark theme pair. Custom overrides only the existing gradient tokens. Store the enabled state and two colors with the current per-community appearance preference and local cache. Keep existing Color mode, glass and preference rows.

**Tech Stack:** React, TypeScript, CSS variables, existing Nostr preference synchronization.

## Acceptance gate
- Exactly two style tiles: Default and Custom, in the existing expandable picker.
- Color 1 and Color 2 appear only while Custom is selected.
- Default restores the original accent-derived gradient values without changing other settings.
- Custom colors survive reload, theme mode changes, and community synchronization; invalid colors never reach CSS.
- Existing stored themes migrate to the default light/dark pair; old appearance records without custom fields remain readable.

## Tasks
- [x] Add validated custom-gradient preferences and pure light/dark stop generation, with tests covering invalid colors, equal colors, and contrast-friendly extremes.
- [x] Wire preferences into ThemeProvider cache, asynchronous theme application, and per-community parsing/equality/synchronization.
- [x] Replace the existing style tile collection with Default and Custom using the same preview components and layout. Add two labeled native color inputs in existing setting rows.
- [x] Run focused theme tests, typecheck and changed-file formatting. Exercise the existing page through the mock bridge in light, dark and system modes, including reload and restoring Default.

No local production build or full CI. GitHub CI, merge, packaged app, and live account proof are separate later gates.

## Verification
- 45 focused theme unit tests passed, including gradient validation, saved preferences, outbox synchronization, and legacy theme migration.
- 10 focused browser scenarios passed against a Vite E2E mock-bridge preview: Custom edits/reload/Default restoration, invalid settings, existing layout, light/dark/system changes, glass, legacy migration, prominent selection, and keyboard settings access.
- TypeScript and changed-file Biome checks passed.
- Actual Appearance screenshots: `output/playwright/appearance-default.png`, `output/playwright/appearance-custom.png`, and `output/playwright/appearance-custom-dark.png`.
- Local source and mocked-browser proof only. Release branch prepared on current develop; GitHub CI, merge, publication and installed-app proof remain separate gates.

Integration note: the current workspace gradient and pattern engine is preserved. Custom overrides its chrome colors, retaining the original reading surfaces. Default keeps its existing accent and background controls.
