# Colony Onboarding V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the technical first-run setup with the approved founder, website, automatic runtime, Scout, and first-task journey while preserving recovery and exactly-once guarantees.

**Architecture:** Machine onboarding creates or recovers the Nostr identity without exposing key or provider setup. The connected-community transaction becomes the durable v2 state machine, owns founder and company context, invokes an SSRF-safe native website scan with a 300-second ceiling, chooses a usable runtime automatically, and provisions exactly one Scout before durably sending the first task. Billing is an adapter boundary because the repository currently has a balance reader but no checkout or top-up provider.

**Tech Stack:** React 19, TypeScript, Motion, Tauri 2, Rust, `buzz-cli` company scanner, TanStack Query, node:test, Playwright.

---

## Scope guardrails

- Exactly one starter persona: `builtin:fizz`, displayed as Scout, Chief of Staff.
- Do not expose identity keys, backup files, relays, harnesses, providers, API keys, or terminals on the new-user critical path.
- Returning-user recovery remains available behind the secondary entry action.
- Website scan accepts only public HTTPS targets and never merges a late result after failure or timeout.
- Founder gender is optional, never inferred, and includes `prefer-not-to-say`.
- The first task is sent once. Retry must reuse the saved task and delivery receipt.
- Billing UI does not claim a card was linked or money moved until a real provider adapter returns a receipt.
- Existing users and add-community flows keep their current behavior.

## Acceptance gates

1. **Journey contract:** the durable stage graph is founder, website, scan, summary or description fallback, automatic runtime, optional Colony Agent billing/model, Scout activation, first task, entering.
2. **Website evidence:** invalid/private URLs are rejected, scans stop after 300 seconds, cancellation prevents late merge, and evidence produces an editable bounded summary.
3. **Automatic setup:** a ready supported CLI is chosen without a chooser or payment; no usable CLI selects Colony Agent and DeepSeek V4 Flash without exposing technical controls.
4. **Exactly-once handoff:** retries cannot create a second Scout, double-charge, or send the first task twice.
5. **Product proof:** desktop package tests pass and Playwright drives both the CLI and Colony Agent branches, including recovery and reduced-motion behavior.

### Task 1: Add the durable v2 journey contract

**Files:**

- Create: `desktop/src/features/onboarding/onboardingV2.ts`
- Create: `desktop/src/features/onboarding/onboardingV2.test.mjs`
- Modify: `desktop/src/features/onboarding/communityOnboarding.tsx`
- Modify: `desktop/src/features/onboarding/communityOnboarding.test.mjs`

- [ ] **Step 1: Write failing stage and validation tests**

```ts
assert.equal(nextOnboardingStage("founder", { founderValid: true }), "website");
assert.equal(nextOnboardingStage("scan", { scanStatus: "success" }), "summary");
assert.equal(nextOnboardingStage("scan", { scanStatus: "timeout" }), "description");
assert.equal(normalizeFounderGender(""), null);
assert.equal(normalizeFounderGender("prefer-not-to-say"), "prefer-not-to-say");
assert.equal(isValidBusinessWebsite("https://example.com"), true);
assert.equal(isValidBusinessWebsite("http://127.0.0.1"), false);
```

- [ ] **Step 2: Run `pnpm --dir desktop test` and confirm the new tests fail**
- [ ] **Step 3: Implement the typed stages, draft, transition guards, and serialization parser**
- [ ] **Step 4: Extend the community transaction with `onboardingV2` and preserve it across restart**
- [ ] **Step 5: Run `pnpm --dir desktop test` and confirm the complete package passes**

### Task 2: Expose the bounded company scanner to onboarding

**Files:**

- Create: `desktop/src-tauri/src/commands/company_scan.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/Cargo.toml`
- Create: `desktop/src/shared/api/tauriCompanyScan.ts`
- Create: `desktop/src/shared/api/tauriCompanyScan.test.mjs`
- Modify: `desktop/src/testing/e2eBridge.ts`

- [ ] **Step 1: Write failing tests for the IPC parser and 300-second request contract**

```ts
const result = fromRawCompanyScan({
  requested_url: "https://example.com",
  canonical_url: "https://example.com/",
  pages: [{ url: "https://example.com/", title: "Example", text: "Useful evidence" }],
  warnings: [],
});
assert.equal(result.canonicalUrl, "https://example.com/");
assert.match(buildEditableCompanySummary(result), /Useful evidence/);
assert.equal(COMPANY_SCAN_TIMEOUT_MS, 300_000);
```

- [ ] **Step 2: Run the desktop package tests and confirm red**
- [ ] **Step 3: Add a Tauri command that calls the existing scanner with `total_timeout = 300s` and maps errors into `invalid`, `failed`, or `timeout`**
- [ ] **Step 4: Add the frontend adapter, abort/late-result guard, bounded summary builder, and E2E mock**
- [ ] **Step 5: Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml` and `pnpm --dir desktop test`**

### Task 3: Build the approved chromatic onboarding surface

**Files:**

- Create: `desktop/src/features/onboarding/ui/OnboardingV2Flow.tsx`
- Create: `desktop/src/features/onboarding/ui/OnboardingV2Shell.tsx`
- Create: `desktop/src/features/onboarding/ui/OnboardingV2PheromoneTrail.tsx`
- Create: `desktop/src/features/onboarding/ui/onboardingV2Copy.ts`
- Modify: `desktop/src/index.css`
- Modify: `desktop/src/features/onboarding/ui/CommunityOnboardingFlow.tsx`

- [ ] **Step 1: Add source-contract tests for all 34 approved screen IDs and their hue/error family**
- [ ] **Step 2: Implement the violet, blue, pink, amber, and green shell with one persistent ant/trail layer**
- [ ] **Step 3: Implement founder, website, scan, editable summary, and fallback forms with preserved input on failure**
- [ ] **Step 4: Use Motion only for transform/opacity, 200 to 300 ms directional transitions, and a full reduced-motion path**
- [ ] **Step 5: Integrate the v2 flow only for `first-community`; retain the current add/join/recovery screens**
- [ ] **Step 6: Run `pnpm --dir desktop check`, `pnpm --dir desktop typecheck`, and `pnpm --dir desktop test`**

### Task 4: Automate runtime selection and Scout handoff

**Files:**

- Create: `desktop/src/features/onboarding/automaticRuntime.ts`
- Create: `desktop/src/features/onboarding/automaticRuntime.test.mjs`
- Create: `desktop/src/features/onboarding/firstTaskDelivery.ts`
- Create: `desktop/src/features/onboarding/firstTaskDelivery.test.mjs`
- Modify: `desktop/src/features/onboarding/ui/OnboardingV2Flow.tsx`
- Modify: `desktop/src/features/onboarding/ui/MachineOnboardingFlow.tsx`
- Modify: `desktop/src/features/onboarding/hooks.ts`
- Modify: `desktop/src/features/onboarding/ui/CommunityOnboardingFlow.tsx`

- [ ] **Step 1: Write failing selection tests**

```ts
assert.equal(selectAutomaticRuntime([ready("codex"), ready("claude")]), "codex");
assert.equal(selectAutomaticRuntime([missing("codex")]), "buzz-agent");
assert.deepEqual(defaultColonyAgentConfig(), {
  preferred_runtime: "buzz-agent",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  credential_mode: "colony_credits",
});
```

- [ ] **Step 2: Make fresh identity creation automatic behind `Start my company`; keep returning-user recovery secondary**
- [ ] **Step 3: Detect readiness, select the best supported CLI, and persist its valid current configuration without showing a chooser**
- [ ] **Step 4: On the Colony Agent branch install the signed runtime, select the recommended model, and stop at the real billing adapter if no receipt exists**
- [ ] **Step 5: Reuse `ensureWelcomeTeam` and `initializeStarterChannels`, then send the confirmed founder/company context and first task once using a stable client marker**
- [ ] **Step 6: Run all desktop tests and the affected Tauri package tests**

### Task 5: Prove the real journey and recovery matrix

**Files:**

- Modify: `desktop/tests/e2e/onboarding.spec.ts`
- Create: `desktop/tests/e2e/onboarding-v2.spec.ts`
- Modify: `desktop/tests/helpers/bridge.ts`

- [ ] **Step 1: Drive the ready-CLI path through Scout and assert no billing UI appears**
- [ ] **Step 2: Drive invalid URL, scan failure, and 300-second timeout with preserved fallback input**
- [ ] **Step 3: Drive Colony Agent install, payment pending, model unavailable, Scout activation retry, and delayed first-task delivery**
- [ ] **Step 4: Restart at every durable stage and assert the same stage and draft return**
- [ ] **Step 5: Assert exactly one `builtin:fizz` agent, one first-task message, no other starter personas, and no technical critical-path copy**
- [ ] **Step 6: Run `pnpm --dir desktop test:e2e:smoke`, then `just ci` at the exact branch head**

