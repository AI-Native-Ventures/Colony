# First-job handoff completion plan

> For agentic workers: use the existing collaboration tools for the bounded
> slices below. The user already approved the onboarding design and autonomous
> implementation. Root integrates and reviews each slice before delivery.

**Goal:** Finish the approved onboarding handoff in its existing Welcome thread:
an editable setup suggestion, explicit Start, truthful funding/readiness/retry
states, and a real task/output path when an approved worker is available.

**Architecture:** Preserve the existing account/recovery/business implementation
and channel/thread navigation. Reuse Blocks presentation primitives, the native
configuration and credit services, relay-authoritative thread Tasks, and existing
managed ACP agents. The onboarding attempt stores only draft and retry state;
canonical task records and signed messages remain authoritative for work.

**Tech Stack:** React/TypeScript, existing native Rust/Electron bridge, Nostr
events, Node regression tests, Playwright, isolated native relay/provider fixtures.

## Why this follow-up is required

The completion audit found that the prior implementation plan had narrowed the
approved first-job subsection to preserving Welcome. The current source sends
an invented "Get to know..." brief automatically, a desktop-authored Scout opener
says "I am on it", balance-read errors are suppressed, and runtime start failures
are logged rather than recoverable in the thread. The packaged signup gate proves
Account/Recovery/relaunch, not business provisioning or an agent's first output.

The original acceptance contract is
`../specs/2026-09-08-simple-founder-onboarding-design.md`, especially "The first
job, inside Colony" and acceptance gates 3–4. PR #655 may land its independently
proven visual/reliability slice; the overall redesign goal stays open until this
remaining subsection is implemented and its stated proof passes.

## Preserved boundaries

- No new task store, initiative, social publishing workflow, agent catalogue,
  free-credit allowance or billing policy.
- Fresh Welcome currently provisions only the Chief of Staff. Do not silently
  hire a worker or bypass blueprint/owner approval. When the existing supported
  worker handoff is unavailable, show a blocked state with retry and access to
  the existing team review/setup flow, as the approved spec requires.
- The successful native fixture explicitly supplies one approved same-owner,
  same-relay worker through real native persona/agent APIs. This is a fixture
  precondition, not proof that fresh default businesses are automatically staffed.
- Scout coordinates/reviews; the worker executes. Use existing ACP message
  delegation and canonical Tasks. Do not substitute the separate durable jobs
  employee registry or treat an ACP reply as a durable-job receipt.
- No paid provider calls, hosted accounts, private browser sessions, public
  tunnels, system DNS/trust changes or production promotion in validation.

## Shared contract

The pure controller owns sequencing, not UI state storage or native policy.

```ts
export type FirstJobScope = {
  ownerPubkey: string;
  relayUrl: string;
  channelId: string;
  threadRootId: string;
  requestId: string;
};

export type FirstJobTeam = {
  scoutPubkey: string;
  workerPubkey: string;
};

export type FirstJobStartResult =
  | { kind: "needs-credits" }
  | { kind: "blocked"; message: string }
  | { kind: "sent"; eventId: string; taskId: string };

export type FirstJobStartDependencies = {
  assertCurrent(scope: FirstJobScope): Promise<void>;
  ensureConfig(scope: FirstJobScope): Promise<{
    credentialMode: "colony_credits" | "byok";
  }>;
  readAvailableCredits(scope: FirstJobScope): Promise<bigint>;
  ensureTeam(scope: FirstJobScope): Promise<FirstJobTeam | null>;
  dispatchOnce(input: {
    scope: FirstJobScope;
    content: string;
    team: FirstJobTeam;
  }): Promise<{ eventId: string; taskId: string }>;
};
```

`ensureTeam` must not start a paid turn or invent staffing. The adapter validates
the existing same-owner/relay worker and supported runtime. A null result means
the existing handoff is unavailable. Configuration, credit-read and start errors
remain errors with a visible retry; they are never converted to zero credits or
successful work. `dispatchOnce` captures native scope, starts supported agents,
resolves the canonical task, and publishes a prepared request safely.

## Task 1: Pure Start and funding controllers

Owner: onboarding audit worker. Files:

- Add `desktop/src/features/onboarding/firstJobStart.ts` and `.test.mjs`.
- Add `desktop/src/features/onboarding/firstJobCredits.ts` and `.test.mjs`.
- Reuse `contracts.ts`, `paymentsService.ts`, `lib/wiredPaymentsService.ts` and
  `shared/api/tauriProvisionedCredits.ts`; do not alter prices or endpoints.

- [ ] Write failing tests for zero credits, unknown credits, unsupported worker,
  configuration rejection, stale scope between awaits, duplicate in-flight
  Start, uncertain dispatch, and a successful canonical result.
- [ ] Implement `createFirstJobStarter(dependencies)` using the shared types.
  Validate a nonempty bounded brief. Recheck scope after awaited operations.
  Only Colony Credits reads the gateway balance; preserve supported own-key
  settings. A nonpositive available balance returns `needs-credits` before any
  worker start, task creation or message publication. Same-scope in-flight
  calls share one operation; persistence belongs to the adapter.
- [ ] Add a funding controller with injected existing payments service and
  scoped attempt persistence. Read actual packs; initialize using only the
  chosen pack ID and receipt email. Persist the returned reference before
  opening the native browser. A failed open retains it. An initialization
  timeout is uncertain and must not automatically initialize another checkout.
- [ ] Verify the stored reference on return/check-again, then reread exact
  available gateway credits. Paid verification alone does not enable work.
  Returning funds only enables the explicit Start action; it does not dispatch
  automatically. Test false verification, stale balance, read failure and
  identity/community change.
- [ ] Run the focused Node tests through the repository's existing test runner
  and scoped Biome check. Root reviews sequencing and side-effect counts.

## Task 2: Scoped suggestion, preparation and canonical dispatch

Owner: root. Files:

- Add a bounded first-job message/persistence model under
  `desktop/src/features/onboarding/firstJob*.ts`, with regression tests.
- Adapt `onboardingV2FirstTask.ts`, `flow/completeFirstRun.ts` and its IO,
  `flow/founderBrief.ts`, `founderBriefSummary.ts`, and Welcome kickoff gating.
- Reuse `features/company/workContext.ts`, `taskThreadModel.ts`, existing
  managed-agent APIs, `signRelayEvent` and the captured relay publish path.

- [ ] Store a versioned, bounded suggestion payload in a `client` tag alongside
  the existing delivery marker. Its body is readable Markdown for other clients.
  The payload is data, not instructions to auto-execute. A forged or malformed
  marker cannot authorize actions: validate the actual root signer/current owner,
  channel, current community and payload before offering Start.
- [ ] Preserve the same root across completion retries/relaunch and focus it in
  the existing right thread pane. Old context-only messages keep their existing
  presentation. New setup must not also run the old automatic paid kickoff or
  author "I am on it" as Scout.
- [ ] Keep an editable draft and an immutable submitted attempt scoped by owner,
  relay, channel and root. Persist preparation before publication. A signed event
  is public message data, not a secret; do not store passwords or recovery material
  here. Use same-origin locking/single-flight for two mounted panes/windows.
- [ ] Resolve the canonical Task through `createWorkContextResolver` with stable
  `sendId`, existing root, and Scout as accountable coordinator. Capture and
  validate owner/relay around planning and publication; do not let global active
  scope change an in-flight destination.
- [ ] Reuse the existing event-sign/publish primitives with stable `createdAt`
  and exact native-compatible channel/thread/mention/work tags. Persist the
  signed event before publishing; uncertain retry publishes the same event ID.
  A boolean marker precheck alone is insufficient. If another device owns an
  incomplete start that cannot be reconciled, display uncertainty rather than
  dispatching a second instruction.
- [ ] Start the existing supported coordinator/worker only after funding and
  current-scope checks. Their actual tool/message delegation remains the agent's
  work; the UI must not implement a caption-generation workflow.
- [ ] Observe canonical Task and real runtime/output state. Sent is distinct
  from running, failed, reviewable output and completed. Completion requires the
  existing legitimate task report/transition, not a timer or placeholder reply.
- [ ] Prove immutable event retry, scope change, unsupported worker, failed
  native start, task receipt failure and duplicate pane/window actions before
  accepting the adapter.

## Task 3: Inline first-job and funding UI

Owner: root, with independent review. Files:

- Add `ui/FirstJobSuggestion.tsx` and small hooks/components under onboarding.
- Wire the existing `MessageRow`/timeline body slot and existing navigation.
- Reuse `features/blocks/ui/primitives/BlockCard`, shared form controls and
  existing credit pack formatting/presentation.

- [ ] Render "Setup suggestion", the business context, Scout's coordinator role,
  a brief the owner can edit, and Start. Use the approved spacing/type/accent
  system. This is a core onboarding presentation using existing primitives, not
  a new business-specific card system.
- [ ] Keep one state per root when the channel and thread show the same message.
  An owner action in either pane updates both; other authors see readable context
  without a misleading Start action. Ordinary replies/inline work remain intact.
- [ ] Show pending, needs-credits, unknown-balance error, unavailable worker,
  configuration/start failure and uncertain-send states with appropriate retry.
  Add credits uses actual pack prices; Explore for now returns to normal app use.
  Keep the checkout reference and job context through navigation/relaunch.
- [ ] After verified funds, offer Start again. After accepted dispatch show the
  canonical task state and actual output in the same thread; never synthesize
  an agent response or mark work complete when the send succeeds.
- [ ] Capture actual desktop/narrow and light/dark suggestion, funding, failure
  and real-output states. Run interaction tests for scope changes, independent
  drafts and retained existing navigation.

## Task 4: Joined native fixture and delivery

Owners: native recovery worker (agent/task half), signup diagnosis worker
(account/provisioning half), root integration.

- [ ] Reuse `src-electron/signup-smoke.mjs` and `managed-smoke.mjs` fixture patterns.
  Account crypto/encrypted persistence, provisioning, workspace application,
  managed launches, CLI tools and signed relay replies must remain real. Only
  the account/network test environment, save-dialog destination and deterministic
  provider responses are fixtures. Never substitute completed workspace state.
- [ ] Resolve isolated tenant transport explicitly before implementing the joined
  gate. Provisioning creates `wss://<slug>.<domain>` and forbids ports. Preserve
  canonical host/NIP-98 semantics and stored community URLs. Any local trust/DNS
  adapter must be fixture-only, compiled out of normal releases, process-scoped,
  documented and separately tested. Do not alter system DNS/trust or public data.
- [ ] Verify actual signup → recovery save/relaunch → business provisioning →
  private Welcome and single suggestion root. Return owner/relay/channel/root
  identifiers to the agent fixture.
- [ ] First prove fresh-only-Chief blocks Start without task/model calls. Then
  explicitly supply one fixture-approved same-owner/relay worker using real
  native persona/managed-agent APIs and membership, not a name-derived rank.
- [ ] Click real Retry/Start. Use deterministic local provider responses to make
  Chief delegate through actual `buzz messages send --reply-to ... --mention ...`;
  worker publishes a reviewable signed output; Chief reviews and legitimately
  calls `buzz tasks report-complete` on its assigned canonical Task. Assert Task
  creation precedes the instruction, distinct identities, isolated launches,
  same root/Task through reload, and no external model calls.
- [ ] Exercise zero/unknown balance, verified payment return without available
  funds, configuration/start failure and uncertain send/relaunch. Separate this
  transport/control proof from model quality, real payment and hosted signup.
- [ ] Run required local/repository checks and focused review, publish actual
  screenshots, open a signed follow-up PR to develop, enable auto-merge under
  the current rules, verify every required check and actual merge, and rebuild
  the relevant beta. Keep PR #655's package/source evidence separate.

## Acceptance gate

The first job is a truthful, usable continuation of the approved onboarding in
the existing channel/right-thread layout. An owner can edit and explicitly start
it, recover from funding/readiness/send failures without duplicate work, and
review real runtime output when an approved worker is available. The fresh
unstaffed condition is visible and does not masquerade as execution. Native
fixture proof, review, CI, merged source and available package must each be
established before closing the overall redesign goal.
