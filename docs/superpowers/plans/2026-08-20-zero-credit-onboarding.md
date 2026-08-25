# Zero-Credit Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Colony Credits users enter the product at a zero balance, clearly warn that agents are paused, and keep the current balance visible beside the profile.

**Architecture:** The onboarding state machine records an integer-safe credit status but never treats it as an entry gate. The existing relay HTTP 402 response remains the execution authority. A focused sidebar balance component reads the same authenticated account contract only when Colony Credits is the active credential mode and opens Settings, Agents when selected.

**Tech Stack:** React 19, TypeScript, TanStack Query, Tauri IPC, node:test, Playwright.

---

### Task 1: Make credit status durable and non-blocking

**Files:**

- Modify: `desktop/src/features/onboarding/onboardingV2.ts`
- Modify: `desktop/src/features/onboarding/onboardingV2.test.mjs`

- [x] **Step 1: Write failing state-machine assertions**

```ts
assert.equal(nextOnboardingStage("agent-install"), "model");
assert.deepEqual(createOnboardingV2Draft().credits, {
  balanceNanousd: null,
  status: "unavailable",
});
```

- [x] **Step 2: Run the focused test and confirm the old payment transition fails**

Run from `desktop/`:

```bash
node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/onboardingV2.test.mjs
```

Expected: FAIL because `agent-install` still transitions to `payment-method` and the draft has no `credits` field.

- [x] **Step 3: Add the durable credit state and remove payment stages**

```ts
export type OnboardingCreditStatus = "active" | "depleted" | "unavailable";

credits: {
  balanceNanousd: string | null;
  status: OnboardingCreditStatus;
};

case "agent-install":
  return "model";
```

- [x] **Step 4: Run the focused test and confirm it passes**

### Task 2: Continue onboarding at zero balance with honest copy

**Files:**

- Modify: `desktop/src/features/onboarding/ui/OnboardingV2Flow.tsx`
- Modify: `desktop/src/features/onboarding/ui/onboarding-v2.css`

- [x] **Step 1: Replace the payment gate after Colony Agent installation**

```ts
const account = await getColonyCreditsAccount();
patch({
  stage: "model",
  credits: {
    balanceNanousd: account.balance_nanousd,
    status: getColonyCreditsStatus(account.balance_nanousd),
  },
});
```

On account-read failure, continue to `model` with `status: "unavailable"`.

- [x] **Step 2: Remove payment props, payment handlers, and payment screens**

`OnboardingV2Flow` must no longer accept `paymentSetupAvailable` or `onStartPaymentSetup`. Delete the `payment-method` and `credits` render branches and the `$5 starting balance` claim.

- [x] **Step 3: Render the warning before the first task**

```tsx
{draft.runtime.route === "colony-agent" &&
draft.credits.status !== "active" ? (
  <div className="buzz-onboarding-v2__credits-warning" role="status">
    You can enter Colony now. Scout and other agents will not respond until
    you add credits. Your balance is always visible beside your profile.
  </div>
) : null}
```

- [x] **Step 4: Run TypeScript and the onboarding unit suite**

```bash
pnpm typecheck
pnpm test
```

Expected: both commands exit 0.

### Task 3: Add the persistent sidebar balance control

**Files:**

- Create: `desktop/src/features/sidebar/ui/SidebarCreditsBalance.tsx`
- Modify: `desktop/src/features/sidebar/ui/SidebarProfileCard.tsx`
- Create: `desktop/src/features/sidebar/ui/sidebarCreditsBalance.test.mjs`

- [x] **Step 1: Write the failing source contract test**

```ts
assert.match(source, /credential_mode === "colony_credits"/);
assert.match(source, /formatNanousdAsUsd/);
assert.match(source, /onOpenSettings\("agents"\)/);
assert.match(source, /refetchInterval: 30_000/);
```

- [x] **Step 2: Run the focused test and confirm the component is missing**

```bash
node --import ./test-loader.mjs --experimental-strip-types --test src/features/sidebar/ui/sidebarCreditsBalance.test.mjs
```

Expected: FAIL with `ENOENT` for `SidebarCreditsBalance.tsx`.

- [x] **Step 3: Implement the authenticated balance query**

Use `useGlobalAgentConfig()` to enable the query only for `credential_mode: "colony_credits"`. Fetch `getColonyCreditsAccount`, format through `formatNanousdAsUsd`, refresh every 30 seconds, and render `Balance unavailable` on read failure.

- [x] **Step 4: Mount the balance below the profile identity row**

Stop click propagation so selecting the balance opens Settings, Agents instead of toggling the profile popover.

- [x] **Step 5: Run the focused test and full desktop unit suite**

### Task 4: Drive zero-balance onboarding and sidebar visibility

**Files:**

- Modify: `desktop/tests/helpers/bridge.ts`
- Create: `desktop/tests/e2e/onboarding-v2-credits.spec.ts`

- [x] **Step 1: Expose the existing mock account options to Playwright**

```ts
globalAgentConfig?: {
  credential_mode?: "byok" | "colony_credits";
  env_vars: Record<string, string>;
  provider: string | null;
  model: string | null;
  preferred_runtime?: string | null;
};
colonyCreditsAccount?: {
  balance_nanousd: string;
  currency: "USD";
  status: "active" | "depleted";
};
```

- [x] **Step 2: Seed the durable first-task stage at zero balance**

Drive the screen and assert the exact warning is visible while no payment or card copy exists.

- [x] **Step 3: Seed a completed Colony Credits user**

Open the product shell, assert `Credits $0.00` is visible beside the profile, select it, and assert Settings opens at Agents.

- [x] **Step 4: Run the dedicated Playwright spec**

```bash
PLAYWRIGHT_PORT=4188 pnpm exec playwright test tests/e2e/onboarding-v2-credits.spec.ts --project=integration
```

Expected: all scenarios pass.

### Task 5: Verify, commit, publish, and merge

**Files:**

- Modify: `docs/superpowers/plans/2026-08-20-colony-onboarding-v2.md`

- [x] **Step 1: Update the parent onboarding plan**

Replace the obsolete billing gate with the zero-credit entry and visible-balance acceptance gate.

- [x] **Step 2: Run the package and native gates at one exact commit**

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm build
. ./bin/activate-hermit
just desktop-tauri-check
```

- [ ] **Step 3: Commit with repository identity trailers**

```bash
git commit -m "feat(onboarding): allow zero-credit entry" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

- [ ] **Step 4: Open a PR to `develop` with the Product channel UUID**

- [ ] **Step 5: Wait for every CI check, rebase on current `origin/develop`, and re-run CI if the head moves**

- [ ] **Step 6: Merge only after the rebased head is green and report the develop merge commit**
