# Additional Community Onboarding V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan task-by-task with test-first changes and review each diff before committing.

**Goal:** Route newly created hosted communities through a returning-founder V2 journey that collects company context and hands off to Scout without repeating machine setup.

**Architecture:** A new persisted `create-community` source distinguishes hosted creation from joining. It creates the existing V2 draft at `website`; the shared flow receives an `additional-community` journey prop that skips founder and runtime stages, renders a four-node trail, and keeps the scanner and exactly-once handoff unchanged.

**Tech Stack:** React 19, TypeScript, Tauri 2, TanStack Query, node:test, Playwright.

---

### Task 1: Persist the hosted-create journey

**Files:**
- Modify: `desktop/src/features/onboarding/onboardingV2.ts`
- Modify: `desktop/src/features/onboarding/onboardingV2.test.mjs`
- Modify: `desktop/src/features/onboarding/communityOnboarding.tsx`
- Modify: `desktop/src/features/onboarding/communityOnboarding.test.mjs`
- Modify: `desktop/src/features/communities/ui/HostedCommunityCreateFlow.tsx`

- [ ] **Step 1: Add a failing draft test**

```js
const draft = createAdditionalCommunityOnboardingV2Draft();
assert.equal(draft.stage, "website");
assert.equal(draft.founder.fullName, "");
assert.equal(draft.runtime.route, null);
```

- [ ] **Step 2: Add a failing transaction test**

```js
const created = startCommunityOnboarding({
  source: "create-community",
  relayUrl: "wss://new.example",
});
assert.equal(created.onboardingV2?.stage, "website");
```

- [ ] **Step 3: Run `pnpm --dir desktop test` and confirm the new assertions fail.**
- [ ] **Step 4: Add `create-community`, create the website-stage draft, and make the hosted create flow use the new source.**
- [ ] **Step 5: Run `pnpm --dir desktop test` and confirm the package passes.**

### Task 2: Adapt the shared V2 presentation

**Files:**
- Modify: `desktop/src/features/onboarding/ui/OnboardingV2Shell.tsx`
- Modify: `desktop/src/features/onboarding/ui/OnboardingV2Flow.tsx`
- Modify: `desktop/src/features/onboarding/ui/CommunityOnboardingFlow.tsx`
- Modify: `desktop/src/features/onboarding/onboardingV2FirstTask.ts`
- Modify: `desktop/src/features/onboarding/onboardingV2FirstTask.test.mjs`

- [ ] **Step 1: Add failing source-contract tests for the additional journey prop, four-node trail, direct company-to-Scout transition, and optional founder copy.**
- [ ] **Step 2: Add `journey="additional-community"` from a persisted `create-community` transaction.**
- [ ] **Step 3: Map website, context, Scout, and task stages to a four-node chromatic trail and returning-founder copy.**
- [ ] **Step 4: Move confirmed company context directly to Scout and make Back return to the correct summary or description screen.**
- [ ] **Step 5: Omit empty founder and location lines from the first-task message.**
- [ ] **Step 6: Run `pnpm --dir desktop check`, `pnpm --dir desktop typecheck`, and `pnpm --dir desktop test`.**

### Task 3: Prove the user-visible route

**Files:**
- Modify: `desktop/tests/e2e/onboarding-v2-credits.spec.ts`

- [ ] **Step 1: Seed a connected `create-community` transaction at `website`.**
- [ ] **Step 2: Drive the no-website fallback, confirm the business summary, and assert runtime setup never appears.**
- [ ] **Step 3: Drive Scout and the first task, finalize, and assert the onboarding curtain closes into Welcome.**
- [ ] **Step 4: Assert the first-community and join paths retain their current source contracts.**
- [ ] **Step 5: Run the affected Playwright file in CI mode, then run the full desktop package suite and production build at the exact commit.**

### Task 4: Publish through production

**Files:**
- Modify only the repository's standard desktop release version files after the feature PR merges.

- [ ] **Step 1: Commit with the configured human trailers and push using the `nocodeafrica` credential.**
- [ ] **Step 2: Open a PR to `develop` with the Product channel UUID and wait for every check.**
- [ ] **Step 3: Rebase on current `origin/develop`; if the head changes, rerun CI before merging.**
- [ ] **Step 4: Merge to `develop`, prepare the next desktop patch release, and pass its full release CI.**
- [ ] **Step 5: Open and pass the `develop` to `main` promotion gate, then merge.**
- [ ] **Step 6: Verify the published desktop tag, updater metadata, and downloadable macOS and Windows assets.**
