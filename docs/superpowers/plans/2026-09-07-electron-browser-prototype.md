# Electron Shared Browser Implementation Plan

> **For agentic workers:** Execute this bounded plan task-by-task with checkpoints. The optional superpowers execution skills are not installed in this environment; use the repository's ordinary implementation and proof workflow.

**Goal:** Build an isolated Electron browser prototype proving shared tabs, scoped persistent sessions and revocable worker control.

**Architecture:** Native WebContentsView pages share identity with the broker's agent tools. Browser business logic stays behind a narrow main-process broker; a stdio MCP adapter uses ephemeral, tab-scoped grants over a local Unix socket. Keep the existing Tauri app unchanged.

**Tech Stack:** Electron 44.2.0 (official npm registry checked 2026-09-07), Node ESM, sandboxed CJS preload, HTML/CSS, Node test runner.

## Sequence

- [x] Create `experiments/electron-browser/package.json` with pinned Electron, isolated install/lockfile and ignored state. Commands: `npm install`, `npm test`, `npm run test:electron`, `npm start` from this directory. Do not modify the root dependency graph.
- [x] Write negative authority tests in `test/authority.test.mjs`, then implement `src/authority.mjs`. Verify wrong tab, competing controller, revocation, stale revision and bad URL fail before implementing the corresponding guard. Use `node --test test/authority.test.mjs`.
- [x] Add `src/browser.mjs` (Electron tab/session ownership and CDP operations), `src/broker.mjs` (bounded local transport), and `src/mcp.mjs` (stdio adapter). Run `node --check` on every source file and unit tests after edits.
- [x] Add `src/main.mjs`, `src/preload.cjs`, `ui/index.html`, `ui/style.css`, `ui/app.js`: local trusted controls plus native remote browser view. Main IPC accepts only the shell's top-level frame; remote content has no preload. UI supplies explicit tab access and human takeover.
- [x] Add `test/run-electron.mjs`, `test/electron-proof.mjs` and deterministic fixture pages. Run real hidden Electron processes, including a second process against the same test-only profile, and save structured results under ignored `evidence/`. Exercise the adapter against real browser content, not a mocked page implementation.
- [x] Perform an actual native UI check through the computer-use tool and prepare the app for owner login. Record whether Instagram login, external account persistence, matched Tauri benchmarking and production integration remain unproven.
- [x] Write `README.md` with launch, proof, scope, remaining migration inventory and results. Run checks, inspect the diff and commit only prototype files and its documents, signed off. Do not open a PR until repository-required gates are available and completed.

The approved design supplies the acceptance contract. Implementation files and tests are the executable detail; record corrected failures and proof boundaries in the README rather than describing intended behavior as completed work.

## Proof checkpoint

Local prototype and native Instagram login page verified. Seven unit tests and seventeen Electron checks pass. The actual Instagram sign-in, authenticated restart, model-driven Colony harness run, and matched Tauri benchmark remain pending; full migration acceptance has not passed. See the experiment README for evidence and corrected failures.
