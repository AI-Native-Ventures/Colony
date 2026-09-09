# Founder setup and beta recovery implementation plan

**Goal:** Make sign-in import understandable and onboarding produce a named identity and an explicitly chosen, supported agent configuration.

**Architecture:** Reuse native runtime discovery, native configuration persistence, shared configuration fields and relay-authoritative business records. Add one branded Power step; keep browser-import result handling independent. Runtime launch capability comes from the native catalog.

**Tech stack:** React, TypeScript, Rust native core, Electron, GitHub Actions.

- [x] Trace the screenshot errors to import summary, missing account-name collection, native runtime rejection and missing company head.
- [x] Add importer selection/progress/result helpers and regression cases (browser agent).
- [x] Restore name capture, profile propagation and repair for older nameless identities (identity agent).
- [x] Project native launch availability through the catalog and fix Credits credential validation/rendering (runtime agent).
- [x] Add Power step and non-secret resume checkpoint; use supported catalog/config paths, display three lanes honestly (root).
- [x] Trace hosted company-profile/gateway readiness and expose actionable recovery without bypassing business authority (root/runtime agent).
- [x] Adapt existing onboarding browser/native fixtures and inspect code for scope and secret handling.
- [ ] Commit with DCO and hooks disabled for this command only; push and open develop PR, arm auto-merge under required GitHub gates.
- [ ] Read GitHub failures/artifacts, correct regressions, inspect rendered screens and run the packaged beta workflow on the verified source.

All test execution and builds run in GitHub CI, per the owner's explicit instruction. The required regression failure/pass comparison must also happen there if performed. Never describe unexecuted tests as passing.

## Deployment boundary

The owner confirmed on 2026-09-09 that a Vercel AI Gateway account still needs setting up. The running relay does not have `VERCEL_AI_GATEWAY_KEY`; reconnecting or a desktop update cannot enable Credits. Prepare gateway funding and secure credential installation before requesting paid activation. Do not infer budget or purchase approval from the bug-fix request.

Subscriptions are detected and their native launch availability is shown, but Electron currently supports only the isolated bundled Colony Agent. Actual isolated subscription adapters remain a separate implementation and packaged validation phase.
