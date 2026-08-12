# Stale Root Community Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically return installations trapped by the 0.10.13 root-relay auto-connect record to public Create/Join after a confirmed membership denial.

**Architecture:** Add a pure predicate beside community persistence that identifies only the legacy auto-connect record shape. Route onboarding membership denial through a guarded async recovery function; matching live state is quarantined before community-scoped storage is cleared, disconnected, and reloaded, while all non-matching state retains `MembershipDenied`. Recovery compares against an immutable build-time relay value and requires the stored pubkey to match the active identity.

**Tech Stack:** React 19, TypeScript, localStorage community persistence, Tauri bridge configuration, Playwright E2E, Node test runner.

---

### Task 1: Prove the existing failure

**Files:**
- Modify: `desktop/tests/e2e/onboarding.spec.ts`

- [x] Add an E2E fixture with one active community matching the old derived root record, public auto-connect disabled, and relay membership denied.
- [x] Assert that advancing profile setup eventually shows Create/Join, removes `buzz-communities` and `buzz-active-community-id`, keeps the E2E identity override, and never leaves `membership-denied` visible.
- [x] Run `pnpm --dir desktop build:e2e && PLAYWRIGHT_PORT=4188 pnpm --dir desktop exec playwright test tests/e2e/onboarding.spec.ts --project=integration --grep 'recovers legacy auto-connected default community'`.
- [x] Record the expected red result: current code renders `membership-denied` and retains the community.

### Task 2: Add the narrow recovery predicate

**Files:**
- Modify: `desktop/src/features/communities/communityStorage.ts`
- Modify: `desktop/src/features/communities/communityStorage.test.mjs`

- [x] Add table-driven unit cases for the exact legacy shape and each rejection condition: token, repository override, renamed community, multiple communities, inactive record, relay mismatch, and auto-connect enabled.
- [x] Run `pnpm --dir desktop test -- --test-name-pattern='legacy auto-connected default community'` and confirm the new cases fail before implementation.
- [x] Implement `shouldRecoverLegacyAutoConnectedCommunity` as a pure predicate using canonical relay comparison and the existing `deriveCommunityName` contract.
- [x] Rerun the focused unit cases and require all to pass.

### Task 3: Route membership denial through recovery

**Files:**
- Modify: `desktop/src/features/onboarding/ui/OnboardingFlow.tsx`

- [x] Read the immutable build default relay and auto-connect flag only after membership denial has been confirmed.
- [x] If the pure predicate matches, quarantine the live state, disconnect the relay, clear community/navigation state, and reload.
- [x] Scope rollback to the quarantined identity and prove interrupted destination, active-ID, and community writes resume without accepting divergent live state.
- [x] If configuration lookup, quarantine, or the predicate rejects the state, retain the existing `MembershipDenied` behavior.
- [x] Use the same guarded handler for both the membership pre-check and a membership-denied profile-write race.
- [x] Rerun the focused E2E and require it to pass.

### Task 4: Guard existing recovery behavior

**Files:**
- Test: `desktop/tests/e2e/onboarding.spec.ts`

- [x] Run the existing membership-denial and four-affordance Change Community scenarios together with the new recovery case.
- [x] Run `pnpm --dir desktop check` and the focused desktop unit suite.
- [x] Run `git diff --check` and inspect the final diff for product-scope drift.

### Task 5: Ship through protected release gates

**Files:**
- Modify only the four desktop version-contract files required by `just bump-desktop-version` when the release version is selected.

- [ ] Commit the recovery patch with DCO sign-off, push its `codex/` branch, open a PR to `develop`, and arm merge-queue auto-merge.
- [ ] Require feature PR CI and merge-group CI to pass, then verify the merge exists on `origin/develop`.
- [ ] Open the normal `develop` to `main` promotion PR and require the exact `Promotion Gate` plus every non-skipped check to pass.
- [ ] Merge through protection, verify the release tag points exactly to the main merge, and require macOS and Windows desktop release jobs to succeed.
- [ ] Download and inspect the published artifact for version, production WS/HTTP URLs, updater marker, and absent auto-connect/localhost markers.
- [ ] Obtain user-observed affected-install recovery proof without reading the identity key or creating production data solely for the test.
