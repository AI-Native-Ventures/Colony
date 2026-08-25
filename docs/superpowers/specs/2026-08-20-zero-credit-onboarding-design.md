# Zero-Credit Onboarding Design

**Status:** Approved direction from Product thread on 2026-08-20

## Goal

Let founders finish onboarding and enter Colony without linking a card or holding credits, while making it unmistakable that Colony Agent cannot respond at a zero balance and making the live balance easy to see after entry.

## Product decision

The payment-method and credit-confirmation screens leave the onboarding critical path. After Colony Agent installs, onboarding reads the current account balance, records whether agents are paused, and continues to model selection, Scout, and the first task.

If the balance is zero or cannot be read, onboarding explains that the workspace will open but agents will not respond until credits are added. It never claims that payment setup, top-up, or starting credit exists.

## Approaches considered

### 1. Recommended: allow entry and rely on the existing gateway block

- Continue onboarding at any balance.
- Preserve the relay's existing HTTP 402 admission control as the authority that prevents unpaid model work.
- Show a warning before Scout's first task when the account is depleted or unreadable.
- Show the current Colony Credits balance in the persistent sidebar profile area and link it to Settings, Agents.

This is the smallest honest change. It reuses the financial guard already proven in the relay and avoids inventing a checkout provider.

### 2. Queue the first task until credits arrive

Store the first task but do not deliver it until the account becomes active. This could create a smoother later recovery, but it introduces a durable background queue, replay rules, and new exactly-once failure cases. It is unnecessary for this onboarding correction.

### 3. Keep a disabled payment step

Allow a skip action on the existing card screen. This makes a provider that does not exist look broken and leaves technical friction in the critical path. It is rejected.

## Journey changes

The Colony Agent branch becomes:

1. Install Colony Agent.
2. Read the current balance.
3. Continue to the recommended model regardless of balance.
4. Introduce Scout.
5. On the first-task screen, show the zero-credit warning when applicable.
6. Let the founder start the company and enter the workspace.

The detected-CLI branch is unchanged and does not show Colony Credits warnings or balance UI because it does not use Colony Credits.

## Balance visibility

For `credential_mode: "colony_credits"`, the sidebar profile card shows the formatted current balance at all times after entry. Selecting it opens Settings, Agents, where the existing full Colony Credits account card remains available.

The compact balance control:

- displays exact integer-safe USD formatting from `balance_nanousd`;
- uses a clear paused state at `$0.00`;
- refreshes after app focus and periodically while visible;
- stays hidden for bring-your-own-key and detected-CLI users;
- never presents an Add Credits action until a real top-up destination exists.

## Data and failure handling

The onboarding draft stores a credit readiness state of `active`, `depleted`, or `unavailable`. This preserves the warning across restart. A failed balance read is treated as `unavailable`, never as evidence of funded access.

No new money movement, payment provider, database table, or relay endpoint is introduced. The existing relay gateway remains the execution authority and continues returning HTTP 402 before an upstream model call when the balance is insufficient.

## Copy contract

Zero-credit onboarding copy must say:

> You can enter Colony now. Scout and other agents will not respond until you add credits. Your balance is always visible beside your profile.

The copy must not claim that an agent is ready, online, funded, or responding while the account is depleted or unavailable.

## Acceptance gates

1. A Colony Agent user with `$0.00` completes onboarding without seeing a card or payment requirement.
2. The first-task screen clearly states that agents will not respond until credits are added.
3. The detected-CLI path remains unchanged and has no Colony Credits warning.
4. After entry, a Colony Credits user can see the formatted balance from the sidebar and open Settings, Agents from it.
5. Balance read failure is honest and non-blocking.
6. The existing relay HTTP 402 guard remains unchanged and no fake top-up action appears.
7. Desktop package tests, type checking, production build, native compile, and driven UI coverage pass at the same commit.
