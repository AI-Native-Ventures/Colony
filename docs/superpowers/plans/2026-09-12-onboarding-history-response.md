# Approved onboarding implementation plan

**Goal:** Implement the approved four-stage founder onboarding with a real response gate and reviewed, private history import.

**Architecture:** Preserve existing account and business transactions. Add a cancellable verification controller around the existing managed Chief of Staff and relay transport. Native history commands discover bounded supported files, return local draft memories for owner review, and persist approved entries through encrypted agent-owner engrams. History is optional; response verification is not.

**Tech Stack:** React, TypeScript, Rust/Tauri native bridge shared by Electron, Nostr encrypted engrams.

## Acceptance and tasks
- [x] Replace FounderLayout example panels/footer with four-stage progress and approved ant branding; match approved artifact spatially on desktop and narrow windows.
- [x] Add response controller: save configuration, create/reuse private Welcome and Chief of Staff, subscribe before sending, correlate trigger/turn/reply, reject errors, deadline and cancellation, revalidate config at handoff. Test wrong agent/thread/turn, stale events, failed completion and timeout.
- [x] Add bounded history discovery/readers: Codex and Claude Code local JSONL; selected JSON exports for ChatGPT/Claude; explicit unsupported results for other formats. Check symlinks, file size/count budgets and malformed data using synthetic fixtures only.
- [x] Draft explicit user statements locally, with source provenance and secret filtering. Review/edit/exclude before encrypted owner-agent persistence; no raw transcript leaves the computer. Avoid model-generated personal inference and tool execution during extraction.
- [x] Wire history screen after successful test; recheck proof before final completion, preserve existing account/business resume behavior, allow history skip and retry.
- [x] Run focused unit/type/format checks and browser visual checks. Broader builds and native checks run in GitHub-hosted CI; report any unproven native/live boundaries explicitly.

Local extraction deliberately avoids sending historical conversations to an external provider; the same approved review screen presents explicit source statements for owner editing. Discovery is limited to supported application roots, never a whole-disk search.

Remaining proof: hosted native compilation/fixture tests, installed-app response and encrypted-memory recall. No merge, deployment or billing proof claimed.

Proof completed: 16 focused Playwright checks against the E2E-mode Vite server (no build), 33 focused onboarding unit/component checks across the implementation, 6 native-host transport tests, TypeScript, Biome, Rust formatting, file-size and command-inventory checks. Browser fixtures exercise subscription and observer transport; they do not call a real provider. Fixed the mock relay owner-scoping bug revealed by the new test. Preview server stopped after checks.
