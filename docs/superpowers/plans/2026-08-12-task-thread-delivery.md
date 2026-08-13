# Task-thread delivery surface implementation plan

> **For agentic workers:** Implement each checked task in order and preserve the proof boundary in the design spec. Do not broaden this plan into a task dashboard or a new artifact store.

**Goal:** Make a canonical Company Task thread show authoritative durable
execution state, accepted progress/delivery evidence, and open supported
artifacts in the existing in-app workspace.

**Architecture:** Add a strict desktop Job-head reader and a pure task-thread
view model. A dedicated task context component mounts inside the existing
thread panel, reads the existing Company Task repository plus the current Job
head, and opens supported evidence through the existing workspace registry. A
new read-only workspace tab kind presents inline or relay-event content.

**Tech stack:** React 19, TypeScript, TanStack Query, existing relay client,
workspace tab registry, Radix Sheet, Node test runner, Playwright mock bridge.

---

## Guardrails

- [ ] Keep `30181` Company Task and `30191` Job head as the only durable
      sources; do not add another store or status mutation path.
- [ ] Derive work state from Job status/run status/lease expiry, never message
      cadence, typing, or agent activity UI.
- [ ] Never send a `path` artifact to native local file/image readers.
- [ ] Keep synthesized task rows outside conversation paging/unread/thread
      counters.
- [ ] Preserve legacy task and non-task threads.
- [ ] Use rem-based existing type tokens and focused desktop conventions.

## Task 1: Pin the reader and view-model contract

**Files:**

- Create: `desktop/src/features/company/taskRunContracts.ts`
- Create: `desktop/src/features/company/taskRunContracts.test.mjs`
- Create: `desktop/src/features/company/taskThreadModel.ts`
- Create: `desktop/src/features/company/taskThreadModel.test.mjs`
- Modify: `desktop/src/shared/constants/kinds.ts`

- [ ] Write failing tests for exact `task` tag extraction and ambiguous tags.
- [ ] Write failing strict Job-head fixtures for queued/executing/recoverable/
      delivered/failed/abandoned states and malformed evidence.
- [ ] Write failing tests for NIP-33 coordinate collapse and newest current-run
      selection.
- [ ] Write failing tests for lease-expiry recovery, checkpoint row gating,
      primary/supporting artifact order, and legacy fallbacks.
- [ ] Run the two tests and capture the expected red result.
- [ ] Implement the smallest parser/model that makes them green.

## Task 2: Add the scoped repository/hook

**Files:**

- Create: `desktop/src/features/company/taskRunRepository.ts`
- Create: `desktop/src/features/company/taskRunRepository.test.mjs`
- Create: `desktop/src/features/company/useTaskThreadContext.ts`
- Modify: `desktop/src/features/communities/useCommunityInit.ts`

- [ ] Test that every query pins kind and exact `#task`, `#h`, and `#e` tags.
- [ ] Test malformed/cross-thread/cross-channel heads are dropped.
- [ ] Test in-flight reads cannot cross a community reset.
- [ ] Implement current-run reads and a query hook with bounded refresh plus an
      exact lease-expiry state update.
- [ ] Reuse `companyRepository.getTask`; do not cache commercial records to
      disk.

## Task 3: Add read-only artifact workspace opening

**Files:**

- Create: `desktop/src/features/workspace/kinds/artifactKind.tsx`
- Create: `desktop/src/features/workspace/lib/openTaskArtifact.ts`
- Create: `desktop/src/features/workspace/lib/openTaskArtifact.test.mjs`
- Modify: `desktop/src/features/workspace/kinds/index.tsx`

- [ ] Write failing tests for text/event/url/path decisions and event-ID
      verification.
- [ ] Register a non-creatable read-only `artifact` kind using the existing
      Markdown/code surface and visible provenance.
- [ ] Open text immediately; fetch exact event content before opening event;
      open URL only when `web` is registered; refuse local path opening.
- [ ] On success use `openTab` and `setChannelSurfaceMode("workspace")`.
- [ ] Preserve a truthful inline error/fallback when opening is unsupported or
      relay retrieval fails.

## Task 4: Render the thread surface and detail sheet

**Files:**

- Create: `desktop/src/features/company/ui/TaskThreadContext.tsx`
- Create: `desktop/src/features/company/ui/TaskDetailSheet.tsx`
- Modify: `desktop/src/features/messages/ui/MessageThreadPanel.tsx`

- [ ] Add the compact accountable-owner/execution header only for a valid task
      association.
- [ ] Render accepted checkpoint and delivery projections as structured rows
      outside the reply list.
- [ ] Render the primary deliverable card only for accepted delivered evidence.
- [ ] Wire artifact opening and visible unsupported/failure feedback.
- [ ] Add the scoped detail sheet with canonical context and supporting
      evidence; no mutation controls or task lists.
- [ ] Resolve local team/persona names when available and retain stable-ID
      fallbacks.

## Task 5: Prove the desktop behavior

**Files:**

- Create: `desktop/tests/e2e/task-thread-delivery.spec.ts`
- Modify: `desktop/playwright.config.ts` only if the smoke project requires an
  explicit registration.
- Modify: mock bridge fixtures only as narrowly required.

- [ ] Seed a canonical Task and Job head in the E2E mock relay.
- [ ] Prove recovery-pending rendering from an expired accepted lease.
- [ ] Prove checkpoint and delivered evidence render separately from chat.
- [ ] Open the detail sheet and assert owner/expected/supporting context.
- [ ] Open a text/event artifact and assert a read-only workspace tab appears.
- [ ] Prove path evidence shows its fallback and never invokes local file read.
- [ ] Run the focused spec through `pnpm build:e2e`; label it mock UI proof.

## Task 6: Quality and landing gates

- [ ] Run focused Node tests after each layer.
- [ ] Run desktop lint/type/build checks affected by the diff.
- [ ] Run `git diff --check` and inspect the exact intended diff.
- [ ] Run an independent pre-landing review and fix actionable findings.
- [ ] Run `just ci` once if resources permit. If it fails from documented
      CPU/resource pressure, capture it and do not blindly repeat; rely only on
      the focused gates that actually passed.
- [ ] Commit each coherent slice with `git commit -s`.
- [ ] Push, open a PR against `develop`, arm merge-queue auto-merge, and require
      PR and merge-group gates to pass before reporting merged.
- [ ] Report separately: implemented, local contract proof, mock UI proof,
      committed, PR CI, merged, deployed, and live-proven. Do not infer the last
      two from merge.
